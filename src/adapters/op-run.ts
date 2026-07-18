// Shared plumbing for adapters that want to run a caller-supplied op-tree
// spec (src/op/spec.ts) against the leaf registry (src/op/registry.ts),
// rather than one domain function at a time. Used by http.ts's
// `POST /op/run` and mcp.ts's `run_pipeline` tool.
//
// A pipeline's intermediate values are real Handles (claim-checks into a
// Store), not bytes -- but an adapter request is JSON in, JSON out. So the
// caller marks any Handle it wants to seed as input with `{ $handle: true,
// base64, type? }`; hydrate() walks the input and turns those into real
// Handles in a Store before the run (a fresh per-request MemoryStore by
// default, or opts.store below). dehydrate() does the reverse to the result,
// turning any Handle-shaped value it finds back into base64 -- the caller
// never sees or invents a Store key itself.

import type { Cache, Handle, Llm, Store } from '../effects/types.js'
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

// Governors/cache are the one piece of Caps that's meant to persist *across*
// calls (a breaker/token-bucket/AIMD's state, a memo cache) rather than being
// rebuilt fresh per request like the default Store below -- so a host that
// wants opts.retries' breaker/token-bucket/concurrency gating (see
// governor.ts's `runGoverned`) or opts.memo to do anything beyond a silent
// no-op supplies them here, keyed by leaf name, and reuses the same
// map/cache across calls. A memoized leaf's cached output is frequently a
// Handle (or a value with one nested inside it) -- a claim-check that's only
// resolvable against the Store instance it was written to -- so opts.cache
// only actually pays off across calls when opts.store is *also* supplied and
// reused; with the default fresh-per-call MemoryStore, a cache hit's Handle
// silently fails to resolve in dehydrate() on any call after the one that
// produced it.
export type OpRunOpts = { governors?: Record<string, Governor>; cache?: Cache; store?: Store }

/**
 * Executes one adapter-triggered pipeline run end to end: builds the Op tree
 * from `spec`, hydrates `input` into a Store, runs it via runInline, and
 * dehydrates the result back to plain JSON. Absent `opts.store`, each call
 * gets its own fresh MemoryStore -- there's no cross-request state for
 * Handle data, matching the stateless request/response shape of an HTTP
 * route or an MCP tool call -- but `opts.governors`/`opts.cache`/`opts.store`,
 * when supplied, are passed straight through, so a host that constructs them
 * once (e.g. per Worker instance) can share their state across every call
 * instead of every leaf's retries running ungated and every opts.memo being
 * a no-op.
 */
export async function runOpSpec({ spec, input }: OpRunRequest, opts: OpRunOpts = {}): Promise<unknown> {
  const store = opts.store ?? new MemoryStore()
  const caps: Caps = { store, llm: llmUnavailable, clock: { now: () => Date.now() }, sinks: {}, governors: opts.governors, cache: opts.cache }
  const tree = buildOp(spec)
  const hydrated = await hydrate(store, input)
  const result = await runInline(tree, hydrated, caps)
  return dehydrate(store, result)
}
