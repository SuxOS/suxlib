// HTTP adapter: a minimal Cloudflare Worker fetch handler exposing the domain
// functions over HTTP. JSON in (base64 for binary payloads), JSON out. Thin —
// all logic lives in src/domain/*; this file only does request parsing /
// response shaping. Generalized from sux-fileops's src/http.ts during the
// suxlib absorption of sux-fileops.

import { archiveCreate, archiveExtract, ARCHIVE_MIME, ARCHIVE_FORMATS, type ArchiveFormat } from '../domain/archive.js'
import { pdfShrink, pdfPageCount } from '../domain/pdf.js'
import { sanitizeImage, redactText, REDACT_TYPES, type RedactType } from '../domain/sanitize.js'
import { dispatchTransform, TRANSFORM_FORMATS, type Format } from '../domain/transform.js'
import { b64ToBytes, bytesToB64 } from './base64.js'
import { runOpSpec } from './op-run.js'
import { validateOpSpec, type OpSpec } from '../op/spec.js'
import { describePipelineSchema } from '../op/introspect.js'
import { planOpSpec } from '../op/plan.js'
import type { Governor, SinkTarget, LeafFn } from '../op/types.js'
import type { Cache, Store, Llm, Ask, Checkpoint } from '../effects/types.js'
import type { RunGovernedOpts } from '../control/governor.js'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(e: unknown, status = 400): Response {
  return json({ error: (e as Error)?.message ?? String(e) }, status)
}

// Trust model: this Worker has no auth of its own unless FILEOPS_AUTH_TOKEN is
// set as a secret (`wrangler secret put FILEOPS_AUTH_TOKEN`). When unset, every
// route is open — deploying that way is only safe behind an upstream gate
// (Cloudflare Access, mTLS, a private route) that this repo doesn't configure.
// When set, every route below requires `Authorization: Bearer <token>`.
//
// opRunGovernors/opRunCache/opRunStore: optional long-lived instances the
// host builds once (e.g. createGovernor(name, spec) per src/op/registry.ts
// leaf, plus a durable Cache/Store) and passes in on every `fetch` call, so
// POST /op/run's runOpSpec actually gets the breaker/token-bucket/concurrency
// gating and memoization the op engine offers instead of a fresh
// governors-free Caps per request (#119) -- this file doesn't construct or
// hold that state itself, since the thresholds/cache/store backend are a
// host policy choice. Supplying opRunCache without opRunStore is a footgun
// (see op-run.ts's OpRunOpts doc) -- a memoized leaf's Handle-shaped result
// won't resolve against a fresh per-request MemoryStore on a later cache hit.
//
// opRunSinks: host-supplied SinkTarget instances a spec's `sink`/
// `sink.fanout` targets can name, merged alongside op/sinks.ts's built-in
// `store` target. Omitted entirely still leaves `store` reachable.
//
// opRunLlm: a host-supplied Llm implementation (real network calls to
// whatever model backs it are the host's responsibility) so `POST /op/run`
// can actually exercise text.ts's `extract`/`summarize` leaves. Omitted
// entirely, those two leaves throw instead of silently running with a
// do-nothing capability (see op-run.ts's OpRunOpts doc).
//
// opRunLeaves: host-registered LeafFns merged onto LEAF_REGISTRY (see
// op-run.ts's OpRunOpts doc), so a spec's `leaf.name` can resolve against
// logic this library never shipped.
//
// opRunGOpts: a host-supplied RunGovernedOpts (onEvent, custom backoff/sleep/
// rand), passed through unchanged to runInline's 4th argument -- the only way
// to observe retry-attempt/memo-hit/memo-miss GovernorEvents (see op-run.ts's
// OpRunOpts doc). Omitted entirely, runInline's own defaults apply.
//
// opRunAsk: a host-supplied Ask implementation, threaded to runOpSpec's
// `ask` opt so `POST /op/run` can resolve a spec's `ask` step against a real
// human-in-the-loop capability instead of only ever hitting runInline's
// no-capability fallback (see op-run.ts's OpRunOpts doc).
//
// opRunCheckpoint: a host-supplied Checkpoint implementation (#390/#396),
// threaded to runOpSpec's `checkpoint` opt so a crashed `POST /op/run` run
// can be resumed by a later call sharing the same `runId` (returned in the
// response body once opRunCheckpoint is set). Omitted entirely, `POST
// /op/run`'s response shape is unchanged from before #396.
//
// allowRoutes: restrict routing to these paths (e.g. "/transform",
// "/sanitize/text") — every route is reachable when omitted. Mirrors
// mcp.ts's `RegisterFileopsToolsOptions.allow`, so a host embedding this
// Worker can expose a chosen subset without forking the route table.
export type Env = { FILEOPS_AUTH_TOKEN?: string; opRunGovernors?: Record<string, Governor>; opRunCache?: Cache; opRunStore?: Store; opRunSinks?: Record<string, SinkTarget>; opRunLlm?: Llm; opRunLeaves?: Record<string, LeafFn>; opRunGOpts?: RunGovernedOpts; opRunAsk?: Ask; opRunCheckpoint?: Checkpoint; allowRoutes?: string[] }

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.FILEOPS_AUTH_TOKEN) return true
  const header = request.headers.get('authorization') ?? ''
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) return false
  return timingSafeEqualStr(token, env.FILEOPS_AUTH_TOKEN)
}

function unauthorizedResponse(): Response {
  return json({ error: 'unauthorized' }, 401)
}

// Cap request body size before it's buffered/parsed, mirroring the domain-level bomb
// guards (archive.ts's MAX_UNPACK_BYTES, pdf.ts's MAX_PDF_INPUT_BYTES, sanitize.ts's
// MAX_IMAGE_INPUT_BYTES) — otherwise a huge body defeats those guards before they
// ever run, since req.json() fully buffers and parses first.
const MAX_REQUEST_BODY_BYTES = 50_000_000

function bodyTooLargeResponse(): Response {
  return json({ error: `request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes` }, 413)
}

class BodyTooLargeError extends Error {}

// Stream-read the body with a running byte counter instead of trusting Content-Length:
// a chunked (or simply headerless) request has no Content-Length at all, so the header
// check above never fires for it, and req.json() would otherwise fully buffer an
// unbounded body before any guard runs.
async function readCappedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

type Route = { method: string; path: string; handle: (body: unknown, env: Env, signal?: AbortSignal) => Promise<Response> }

const routes: Route[] = [
  {
    method: 'POST',
    path: '/archive/create',
    handle: async (rawBody) => {
      const body = rawBody as { format?: string; files?: Array<{ name: string; base64: string; mtime?: number }> }
      const format = (body.format ?? 'zip') as ArchiveFormat
      if (!ARCHIVE_FORMATS.includes(format)) return errorResponse(new Error('format must be zip, tar, gzip, or tar.gz'))
      if (!Array.isArray(body.files) || !body.files.length) return errorResponse(new Error('`files` array required'))
      for (const f of body.files) {
        if (f.mtime !== undefined && !(typeof f.mtime === 'number' && Number.isFinite(f.mtime))) {
          return errorResponse(new Error(`file '${f.name}' has a non-numeric mtime`))
        }
      }
      const entries = body.files.map((f) => ({ name: f.name, data: b64ToBytes(f.base64), mtime: f.mtime }))
      const out = archiveCreate(format, entries)
      return json({ format, mime: ARCHIVE_MIME[format], bytes: out.length, base64: bytesToB64(out) })
    },
  },
  {
    method: 'POST',
    path: '/archive/extract',
    handle: async (rawBody) => {
      const body = rawBody as { format?: string; base64?: string }
      if (typeof body.base64 !== 'string' || !body.base64) return errorResponse(new Error('`base64` required'))
      const format = (body.format ?? 'zip') as ArchiveFormat
      if (!ARCHIVE_FORMATS.includes(format)) return errorResponse(new Error('format must be zip, tar, gzip, or tar.gz'))
      const { entries, skipped } = archiveExtract(format, b64ToBytes(body.base64))
      return json({
        entries: entries.map((e) => ({ name: e.name, bytes: e.bytes, text: e.text, truncated: e.truncated, mtime: e.mtime, base64: bytesToB64(e.data) })),
        ...(skipped ? { skipped } : {}),
      })
    },
  },
  {
    method: 'POST',
    path: '/pdf/shrink',
    handle: async (rawBody) => {
      const body = rawBody as { base64?: string; keepMetadata?: boolean }
      if (typeof body.base64 !== 'string' || !body.base64) return errorResponse(new Error('`base64` required'))
      const result = await pdfShrink(b64ToBytes(body.base64), { stripMetadata: !body.keepMetadata })
      return json({
        mime: 'application/pdf',
        inputBytes: result.inputBytes,
        outputBytes: result.outputBytes,
        savedPct: result.savedPct,
        base64: bytesToB64(result.bytes),
      })
    },
  },
  {
    method: 'POST',
    path: '/pdf/page-count',
    handle: async (rawBody) => {
      const body = rawBody as { base64?: string }
      if (typeof body.base64 !== 'string' || !body.base64) return errorResponse(new Error('`base64` required'))
      const pageCount = await pdfPageCount(b64ToBytes(body.base64))
      return json({ pageCount })
    },
  },
  {
    method: 'POST',
    path: '/sanitize/image',
    handle: async (rawBody) => {
      const body = rawBody as { base64?: string }
      if (typeof body.base64 !== 'string' || !body.base64) return errorResponse(new Error('`base64` required'))
      const result = sanitizeImage(b64ToBytes(body.base64))
      return json({ kind: result.kind, strippedBytes: result.strippedBytes, base64: bytesToB64(result.bytes) })
    },
  },
  {
    method: 'POST',
    path: '/sanitize/text',
    handle: async (rawBody) => {
      const body = rawBody as { text?: string; types?: string[] }
      if (typeof body.text !== 'string') return errorResponse(new Error('`text` required'))
      if (body.types !== undefined) {
        if (!Array.isArray(body.types) || body.types.some((t) => typeof t !== 'string' || !REDACT_TYPES.includes(t as RedactType))) {
          return errorResponse(new Error(`\`types\` must be an array of: ${REDACT_TYPES.join(', ')}`))
        }
      }
      const result = redactText(body.text, body.types as RedactType[] | undefined)
      return json(result)
    },
  },
  {
    method: 'POST',
    path: '/transform',
    handle: async (rawBody) => {
      const body = rawBody as { data?: string; from?: string; to?: string; delimiter?: string }
      if (typeof body.data !== 'string') return errorResponse(new Error('`data` required'))
      if (typeof body.to !== 'string') return errorResponse(new Error('`to` required'))
      const from = body.from ?? 'auto'
      if (from !== 'auto' && !TRANSFORM_FORMATS.includes(from as Format)) {
        return errorResponse(new Error(`\`from\` must be one of: auto, ${TRANSFORM_FORMATS.join(', ')}`))
      }
      if (!TRANSFORM_FORMATS.includes(body.to as Format)) {
        return errorResponse(new Error(`\`to\` must be one of: ${TRANSFORM_FORMATS.join(', ')}`))
      }
      const out = dispatchTransform(body.data, from as Format | 'auto', body.to as Format, body.delimiter)
      return json({ data: out })
    },
  },
  {
    method: 'POST',
    path: '/op/run',
    handle: async (rawBody, env, signal) => {
      const body = rawBody as { spec?: unknown; input?: unknown; trace?: unknown; runId?: unknown }
      if (!body.spec || typeof body.spec !== 'object') return errorResponse(new Error('`spec` (an op-tree JSON description) is required'))
      const trace = body.trace === true
      const runId = typeof body.runId === 'string' ? body.runId : undefined
      // The request's own AbortSignal wires into cooperative cancellation
      // (#279) unless a host-supplied opRunGOpts already declares one.
      const gOpts = signal ? { ...env.opRunGOpts, signal: env.opRunGOpts?.signal ?? signal } : env.opRunGOpts
      const outcome = await runOpSpec({ spec: body.spec as OpSpec, input: body.input, trace, runId }, { governors: env.opRunGovernors, cache: env.opRunCache, store: env.opRunStore, sinks: env.opRunSinks, llm: env.opRunLlm, leaves: env.opRunLeaves, gOpts, ask: env.opRunAsk, checkpoint: env.opRunCheckpoint })
      // runOpSpec already returns a wrapped object (carrying `runId`, and
      // `trace` when requested) whenever a checkpoint capability is
      // configured -- see op-run.ts's runOpSpec doc -- so only the bare
      // dehydrated-result case (no trace, no checkpoint) still needs
      // wrapping here.
      return json((trace || env.opRunCheckpoint) ? (outcome as object) : { result: outcome })
    },
  },
  {
    method: 'GET',
    path: '/op/schema',
    handle: async (_rawBody, env) => json(describePipelineSchema(env.opRunLeaves, env.opRunSinks)),
  },
  {
    method: 'POST',
    path: '/op/validate',
    handle: async (rawBody, env) => {
      const body = rawBody as { spec?: unknown }
      if (!body.spec || typeof body.spec !== 'object') return errorResponse(new Error('`spec` (an op-tree JSON description) is required'))
      const errors = validateOpSpec(body.spec as OpSpec, env.opRunLeaves)
      return json({ valid: errors.length === 0, errors })
    },
  },
  {
    method: 'POST',
    path: '/op/plan',
    handle: async (rawBody) => {
      const body = rawBody as { spec?: unknown }
      if (!body.spec || typeof body.spec !== 'object') return errorResponse(new Error('`spec` (an op-tree JSON description) is required'))
      return json(planOpSpec(body.spec as OpSpec))
    },
  },
]

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const url = new URL(request.url)
    const allowRoutes = env.allowRoutes ? new Set(env.allowRoutes) : null
    const activeRoutes = allowRoutes ? routes.filter((r) => allowRoutes.has(r.path)) : routes
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, routes: activeRoutes.map((r) => `${r.method} ${r.path}`) })
    }
    const route = activeRoutes.find((r) => r.method === request.method && r.path === url.pathname)
    if (!route) return json({ error: 'not found' }, 404)
    if (!isAuthorized(request, env)) return unauthorizedResponse()
    // Fast path: a declared Content-Length over the cap is rejected without
    // touching the body at all. This alone isn't sufficient — a chunked or
    // otherwise headerless request has no Content-Length to check — so
    // readCappedBody() below enforces the same cap against the actual byte
    // count as it streams, regardless of what (if anything) the header claims.
    const contentLength = request.headers.get('content-length')
    if (contentLength !== null && Number(contentLength) > MAX_REQUEST_BODY_BYTES) return bodyTooLargeResponse()
    let bodyBytes: Uint8Array
    try {
      bodyBytes = await readCappedBody(request)
    } catch (e) {
      if (e instanceof BodyTooLargeError) return bodyTooLargeResponse()
      return errorResponse(e, 400)
    }
    let body: unknown
    try {
      body = bodyBytes.length ? JSON.parse(new TextDecoder().decode(bodyBytes)) : {}
    } catch (e) {
      return errorResponse(e, 400)
    }
    try {
      return await route.handle(body, env, request.signal)
    } catch (e) {
      return errorResponse(e, 400)
    }
  },
}
