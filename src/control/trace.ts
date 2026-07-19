import type { Handle, Store } from '../effects/types.js'

/**
 * Optional, no-op-by-default execution trace for one runInline call: a
 * node-enter/node-exit pair around every Op node runInline dispatches (leaf,
 * pipe, map, mapField, reconcile, sink -- and each of its fanout targets
 * individually, ask, catch), addressed by a `path` built from the route
 * taken through the tree (e.g. a leaf named `scrub` reached via the second
 * step of a pipe, inside a map's fourth item, is `"1/3"`).
 *
 * Deliberately a separate stream from GovernorEvent/onEvent
 * (src/control/events.ts) rather than an extension of it: onEvent's existing
 * consumers (breaker/token-bucket/retry/memo observability) already assert
 * exact event sequences in tests and production wiring alike, and a trace
 * fires once per node the tree actually visits -- folding it into the same
 * union would flood/break every onEvent consumer that isn't asking for it.
 * Wired through RunGovernedOpts.onTrace (src/control/governor.ts) instead,
 * so it rides the same gOpts threading runInline/every adapter already has
 * (#216) with zero further plumbing -- a host wanting a trace out of
 * `POST /op/run`/`run_pipeline`/`pipeline run` supplies `opRunGOpts: {
 * onTrace: (e) => ... }` the same way it already supplies `onEvent`.
 *
 * `node-exit`'s `ok`/`error` on a `catch` node's `try` branch is what
 * answers "why did the fallback fire" -- the thrown error's `.message` is
 * attached there before `runInline`'s `catch` case swallows it to run the
 * fallback, rather than inventing a separate event kind for the same fact.
 *
 * `inputRef`/`outputRef` (#234) are a second, independent opt-in
 * (`RunGovernedOpts.traceSnapshots`) layered on top of the timing/ok/error
 * trace above -- omitted unless a caller asks for both a trace *and*
 * snapshots, so the common case (just `onTrace`) never pays for a Store
 * write per node. Each is a `Handle` pointing at a JSON snapshot of the
 * node's actual input/output value (via `snapshotValue` below), not the
 * value inlined into the event -- every leaf already speaks Handles through
 * `caps.store`, so this reuses that content-addressed store rather than
 * growing the event payload with arbitrary-sized bytes. `outputRef` is only
 * ever attached to a `node-exit` with `ok: true`; a failing node has no
 * output to snapshot (its `inputRef`, on the matching `node-enter`, is what
 * answers "what was flowing in when it broke").
 */
export type TraceEvent =
  | { kind: 'node-enter'; tag: string; name?: string; path: string; inputRef?: Handle }
  | { kind: 'node-exit'; tag: string; name?: string; path: string; durationMs: number; ok: boolean; error?: string; outputRef?: Handle }

export type TraceEventHandler = (e: TraceEvent) => void

// Best-effort: a value that can't be JSON-serialized (e.g. a circular
// reference) must not turn an opt-in debug snapshot into a failed run --
// returns undefined instead of throwing, and the TraceEvent simply omits
// the ref for that node.
export async function snapshotValue(store: Store, value: unknown): Promise<Handle | undefined> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value ?? null))
    return await store.put(bytes, 'application/json')
  } catch {
    return undefined
  }
}
