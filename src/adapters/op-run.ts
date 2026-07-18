// Shared plumbing for adapters that want to run a caller-supplied op-tree
// spec (src/op/spec.ts) against the leaf registry (src/op/registry.ts),
// rather than one domain function at a time. Used by http.ts's
// `POST /op/run` and mcp.ts's `run_pipeline` tool.
//
// A pipeline's intermediate values are real Handles (claim-checks into a
// Store), not bytes -- but an adapter request is JSON in, JSON out. So the
// caller marks any Handle it wants to seed as input with `{ $handle: true,
// base64, type? }`; hydrate() walks the input and turns those into real
// Handles in a fresh per-request MemoryStore before the run. dehydrate() does
// the reverse to the result, turning any Handle-shaped value it finds back
// into base64 -- the caller never sees or invents a Store key itself.

import type { Handle, Llm } from '../effects/types.js'
import { MemoryStore } from '../effects/types.js'
import type { Caps } from '../op/types.js'
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

async function hydrate(store: MemoryStore, value: unknown): Promise<unknown> {
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

async function dehydrate(store: MemoryStore, value: unknown): Promise<unknown> {
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
 * Executes one adapter-triggered pipeline run end to end: builds the Op tree
 * from `spec`, hydrates `input` into a fresh MemoryStore, runs it via
 * runInline, and dehydrates the result back to plain JSON. Each call gets its
 * own Store (and so its own governors-free Caps) -- there's no cross-request
 * state, matching the stateless request/response shape of an HTTP route or
 * an MCP tool call.
 */
export async function runOpSpec({ spec, input }: OpRunRequest): Promise<unknown> {
  const store = new MemoryStore()
  const caps: Caps = { store, llm: llmUnavailable, clock: { now: () => Date.now() }, sinks: {} }
  const tree = buildOp(spec)
  const hydrated = await hydrate(store, input)
  const result = await runInline(tree, hydrated, caps)
  return dehydrate(store, result)
}
