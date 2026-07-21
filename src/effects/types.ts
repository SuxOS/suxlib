export interface Handle { r2Key: string; sha256: string; type: string; size: number; producedAt?: number }
export interface Store { put(bytes: Uint8Array, type: string): Promise<Handle>; get(h: Handle): Promise<Uint8Array> }
export interface Llm { markdownFromPdf(bytes: Uint8Array): Promise<string>; summarize(text: string): Promise<string> }
export interface Clock { now(): number }
export interface Ask { request(prompt: string, timeout: string): Promise<{ answered: boolean; value?: any }> }
// Cache stores a memoized leaf *output* (which may itself be a Handle, an
// array of Handles, or a plain object with Handles nested inside it -- shape
// varies per leaf) under a control/memo.ts memoKey. `undefined` from get()
// means "no entry" -- no leaf output is legitimately undefined, so that's an
// unambiguous miss signal.
export interface Cache { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> }
// Checkpoint records a run's authoritative per-node execution ledger, keyed by
// (runId, path) -- so a resumed runInline call sharing the same runId can
// skip re-executing any node (leaf, sink target, or a whole already-finished
// composite subtree) whose result was already recorded before a prior crash,
// rather than re-running the entire tree from scratch. Deliberately a
// different key space from Cache's `memoKey(name, input)`: Cache dedupes a
// leaf's *(name, input)* pair across unrelated calls/runs, Checkpoint dedupes
// *this one run's* own already-completed nodes. `{ done: true; value }` wraps
// the stored value so a legitimately `undefined` node result is still
// distinguishable from "no checkpoint recorded yet" (get() returning
// `undefined`).
//
// `start(runId, path)` (#425) writes a lightweight in-progress marker at
// node-*enter*, before a node's work runs -- separate from `put`, which still
// only fires at node-exit on success. This is what lets `get()` return a
// third state, `{ done: false }` ("started, no result recorded yet"),
// distinct from `undefined` ("never started"): a status query reading only
// the root path can now tell "never started" apart from "still executing or
// crashed mid-run" (those last two remain inherently indistinguishable from
// ledger state alone -- there's no liveness signal here, only progress).
// `start()` must not clobber an existing entry (a `put`-recorded `done: true`,
// or a prior `start`'s `done: false`) -- traced() calls it unconditionally on
// every non-short-circuited node-enter, including a resumed run's already-
// finished nodes it would otherwise re-run.
export interface Checkpoint {
  get(runId: string, path: string): Promise<{ done: true; value: unknown } | { done: false } | undefined>
  start(runId: string, path: string): Promise<void>
  put(runId: string, path: string, value: unknown): Promise<void>
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export class MemoryStore implements Store {
  private m = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array, type: string): Promise<Handle> {
    const sha = await sha256Hex(bytes); const r2Key = `cas/${sha}`
    if (!this.m.has(r2Key)) this.m.set(r2Key, bytes)
    return { r2Key, sha256: sha, type, size: bytes.byteLength }
  }
  async get(h: Handle): Promise<Uint8Array> {
    const b = this.m.get(h.r2Key); if (!b) throw new Error(`handle not found: ${h.r2Key}`)
    if (b.byteLength !== h.size) throw new Error(`handle size mismatch for ${h.r2Key}: expected ${h.size}, got ${b.byteLength}`)
    const sha = await sha256Hex(b)
    if (sha !== h.sha256) throw new Error(`handle sha256 mismatch for ${h.r2Key}: expected ${h.sha256}, got ${sha}`)
    return b
  }
}
export class MemoryCache implements Cache {
  private m = new Map<string, unknown>()
  async get(key: string): Promise<unknown> { return this.m.get(key) }
  async put(key: string, value: unknown): Promise<void> { this.m.set(key, value) }
}
export class MemoryCheckpoint implements Checkpoint {
  private m = new Map<string, Map<string, { done: true; value: unknown } | { done: false }>>()
  async get(runId: string, path: string): Promise<{ done: true; value: unknown } | { done: false } | undefined> {
    return this.m.get(runId)?.get(path)
  }
  async start(runId: string, path: string): Promise<void> {
    let byPath = this.m.get(runId)
    if (!byPath) { byPath = new Map(); this.m.set(runId, byPath) }
    if (!byPath.has(path)) byPath.set(path, { done: false })
  }
  async put(runId: string, path: string, value: unknown): Promise<void> {
    let byPath = this.m.get(runId)
    if (!byPath) { byPath = new Map(); this.m.set(runId, byPath) }
    byPath.set(path, { done: true, value })
  }
}
