// Shared plumbing for adapters that want to run a caller-supplied op-tree
// spec (src/op/spec.ts) against the leaf registry (src/op/registry.ts),
// rather than one domain function at a time. Used by http.ts's
// `POST /op/run` and mcp.ts's `run_pipeline` tool.
//
// A pipeline's intermediate values are real Handles (claim-checks into a
// Store), not bytes -- but an adapter request is JSON in, JSON out. So the
// caller marks any Handle it wants to seed as input with `{ $handle: true,
// base64, type? }`; hydrate() walks the input and turns those into real
// Handles in the run's Store (a fresh per-call MemoryStore by default, or a
// host-supplied persistent one -- see OpRunOpts below) before the run.
// dehydrate() does the reverse to the result, turning any Handle-shaped value
// it finds back into base64 -- the caller never sees or invents a Store key
// itself.

import type { Handle, Llm, Cache, Store } from '../effects/types.js'
import { MemoryStore } from '../effects/types.js'
import type { Caps, Governor } from '../op/types.js'
import { buildOp, type OpSpec } from '../op/spec.js'
import { runInline } from '../runtime/inline.js'
import { b64ToBytes, bytesToB64 } from './base64.js'

export type HandleRef = { $handle: true; base64: string; type?: string }

function isHandleRef(v: unknown): v is HandleRef {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>).$handle === true
    && typeof (v as Record<string, unknown>).base64 === 'string'
}

function isResolvedHandle(v: unknown): v is Handle {
  if (typeof v !== 'object' || v === null) return false
  const h = v as Record<string, unknown>
  return typeof h.r2Key === 'string' && typeof h.sha256 === 'string' && typeof h.type === 'string' && typeof h.size === 'number'
}

async function hydrate(store: Store, value: unknown): Promise<unknown> {
  if (isHandleRef(value)) return store.put(b64ToBytes(value.base64), value.type ?? 'application/octet-stream')
  if (Array.isArray(value)) return Promise.all(value.map((v) => hydrate(store, v)))
  if (value && typeof value === 'object') {
    // Object.create(null), not {}: a caller-supplied key literally named
    // "__proto__" assigned via out[k] = ... onto a plain {} would hit the
    // inherited Annex-B setter and hijack `out`'s own prototype to whatever
    // object the caller supplied, instead of creating an ordinary "__proto__"
    // data property -- letting later sibling keys silently resolve as
    // *inherited* properties from that object. Same class of bug CLAUDE.md
    // documents for fflate's zip entry names, here reachable via any JSON key.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = await hydrate(store, v)
    return out
  }
  return value
}

async function dehydrate(store: Store, value: unknown): Promise<unknown> {
  if (isResolvedHandle(value)) {
    const bytes = await store.get(value)
    return { base64: bytesToB64(bytes), type: value.type, size: value.size }
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => dehydrate(store, v)))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = await dehydrate(store, v)
    return out
  }
  return value
}

const llmUnavailable: Llm = {
  markdownFromPdf: async () => { throw new Error('llm capability is not available via run_pipeline/op-run') },
  summarize: async () => { throw new Error('llm capability is not available via run_pipeline/op-run') },
}

export type OpRunRequest = { spec: OpSpec; input: unknown }

/**
 * Governors/cache/store a host wants shared across calls (createGovernor per
 * registry leaf, a persistent Cache, a persistent Store) -- CLAUDE.md's
 * "Governor convention" puts policy choices (thresholds, whether to cache at
 * all, what backs the Store) on the host, not this library, so these are
 * threaded through as-is rather than constructed here. Omitted entirely (the
 * pre-#119 behavior) still runs fine: retries still apply,
 * breaker/tokenBucket/concurrency gating and memoization just stay no-ops per
 * runGoverned's own degrade-gracefully pattern, and a fresh MemoryStore backs
 * each call as before.
 *
 * `cache` without also supplying `store` is a real footgun worth calling out:
 * every registry leaf's result is Handle-shaped somewhere in its output, and
 * a Handle only resolves against the Store instance that produced it -- a
 * cache hit on a *later* call whose Handle points into a now-discarded
 * per-call MemoryStore will throw ("handle not found") the moment the result
 * is dehydrated, not silently misbehave. Pass the same `store` alongside
 * `cache` (both long-lived) for cross-call memoization to actually work.
 */
export type OpRunOpts = { governors?: Record<string, Governor>; cache?: Cache; store?: Store }

/**
 * Executes one adapter-triggered pipeline run end to end: builds the Op tree
 * from `spec`, hydrates `input` into a Store (a fresh per-call MemoryStore by
 * default, or `opts.store` when the host supplies one), runs it via
 * runInline, and dehydrates the result back to plain JSON. `opts.governors`/
 * `opts.cache`/`opts.store`, when supplied, are expected to be long-lived
 * instances the host constructs once and passes to every call, so the
 * reliability primitives they gate (breaker trip state, token-bucket fill,
 * memoized results, handle data) actually persist across requests instead of
 * resetting on every stateless HTTP route / MCP tool call.
 */
export async function runOpSpec({ spec, input }: OpRunRequest, opts: OpRunOpts = {}): Promise<unknown> {
  const store = opts.store ?? new MemoryStore()
  const caps: Caps = { store, llm: llmUnavailable, clock: { now: () => Date.now() }, sinks: {}, governors: opts.governors, cache: opts.cache }
  const tree = buildOp(spec)
  const hydrated = await hydrate(store, input)
  const result = await runInline(tree, hydrated, caps)
  return dehydrate(store, result)
}
