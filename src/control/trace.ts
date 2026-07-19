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
 */
export type TraceEvent =
  | { kind: 'node-enter'; tag: string; name?: string; path: string }
  | { kind: 'node-exit'; tag: string; name?: string; path: string; durationMs: number; ok: boolean; error?: string }

export type TraceEventHandler = (e: TraceEvent) => void
