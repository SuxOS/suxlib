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

import type { Handle, Llm, Cache, Store, Ask } from '../effects/types.js'
import { MemoryStore } from '../effects/types.js'
import type { Caps, Governor, SinkTarget, LeafFn } from '../op/types.js'
import { buildOp, type OpSpec } from '../op/spec.js'
import { SINK_REGISTRY } from '../op/sinks.js'
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

// Aggregate cap across every $handle ref a single hydrate() call decodes, not
// just each one individually -- b64ToBytes already caps one base64 string,
// but an input array/object can nest arbitrarily many refs, each passing
// that per-string cap while summing to unbounded MemoryStore growth. Mirrors
// archive_create's totalBytes pattern (mcp.ts) and is sized like
// http.ts's MAX_REQUEST_BODY_BYTES so an MCP call (which has no whole-request
// body cap the way POST /op/run does) can't exceed what an HTTP caller could
// already send in one request.
export const MAX_HYDRATE_BYTES = 50_000_000

async function hydrate(store: Store, value: unknown, budget: { totalBytes: number }): Promise<unknown> {
  if (isHandleRef(value)) {
    const bytes = b64ToBytes(value.base64)
    budget.totalBytes += bytes.length
    if (budget.totalBytes > MAX_HYDRATE_BYTES) {
      throw new Error(`op-run input totals more than ${MAX_HYDRATE_BYTES} bytes across all $handle refs (bomb guard).`)
    }
    return store.put(bytes, value.type ?? 'application/octet-stream')
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => hydrate(store, v, budget)))
  if (value && typeof value === 'object') {
    // Object.create(null), not {}: a caller-supplied key literally named
    // "__proto__" assigned via out[k] = ... onto a plain {} would hit the
    // inherited Annex-B setter and hijack `out`'s own prototype to whatever
    // object the caller supplied, instead of creating an ordinary "__proto__"
    // data property -- letting later sibling keys silently resolve as
    // *inherited* properties from that object. Same class of bug CLAUDE.md
    // documents for fflate's zip entry names, here reachable via any JSON key.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = await hydrate(store, v, budget)
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
 *
 * `sinks`: host-supplied SinkTarget instances (a log, a queue, a second
 * store), merged alongside SINK_REGISTRY's built-in `store` target -- a spec
 * name matching a key here wins over SINK_REGISTRY, letting a host override
 * `store` too if it wants different re-put semantics. Omitted entirely still
 * leaves the built-in `store` target reachable, unlike governors/cache which
 * are pure no-ops when omitted.
 *
 * `llm`: a host-supplied Llm implementation (real network calls to whatever
 * model backs it are the host's responsibility -- this repo stays
 * dependency-light and never constructs one itself), threaded through to
 * `text.ts`'s `extract`/`summarize` leaves the same way `store`/`cache` are.
 * Omitted entirely, `caps.llm` falls back to `llmUnavailable` below, so those
 * two leaves throw a clear error instead of silently running with a
 * do-nothing capability.
 *
 * `leaves`: host-registered LeafFns merged onto LEAF_REGISTRY (src/op/
 * registry.ts's `mergeLeaves`, same host-overrides-built-in order as
 * `sinks`/SINK_REGISTRY), letting a caller-supplied OpSpec's `leaf.name`
 * resolve against logic this library never shipped -- a host embedding
 * suxlib (e.g. `sux`) registering its own leaf. Omitted entirely still
 * resolves every built-in registry leaf as before.
 *
 * `ask`: a host-supplied Ask implementation (src/effects/types.ts), threaded
 * through to an `ask` OpSpec step (#181) the same way `llm`/`store`/`cache`
 * are. Omitted entirely, `caps.ask` stays undefined and runInline's `case
 * 'ask'` honors the step's own `onTimeout` itself -- no durable pause/resume
 * is implied here, per CLAUDE.md's "Ask convention".
 */
export type OpRunOpts = { governors?: Record<string, Governor>; cache?: Cache; store?: Store; sinks?: Record<string, SinkTarget>; llm?: Llm; leaves?: Record<string, LeafFn>; ask?: Ask }

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
  const sinks = Object.assign(Object.create(null), SINK_REGISTRY, opts.sinks) as Record<string, SinkTarget>
  const caps: Caps = { store, llm: opts.llm ?? llmUnavailable, clock: { now: () => Date.now() }, sinks, governors: opts.governors, cache: opts.cache, ask: opts.ask }
  const tree = buildOp(spec, opts.leaves)
  const hydrated = await hydrate(store, input, { totalBytes: 0 })
  const result = await runInline(tree, hydrated, caps)
  return dehydrate(store, result)
}
