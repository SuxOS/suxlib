/**
 * Optional, no-op-by-default execution trace for one runInline call: a
 * node-enter/node-exit pair around every Op node runInline dispatches (leaf,
 * pipe, map, mapField, reconcile, sink -- and each of its fanout targets
 * individually, ask, catch), addressed by a `path` built from the route
 * taken through the tree (e.g. a leaf named `scrub` reached via the second
 * step of a pipe, inside a map's fourth item, is `"1/3"`).
 *
 * `path` alone is only unique *within* one runInline call -- every call's
 * own root is `path === ''`, and two calls sharing the same op-tree shape
 * produce identical relative paths throughout. `runId` (#346) disambiguates
 * across calls: minted once per top-level runInline invocation and threaded
 * unchanged through every recursive call/traced() node for that run, so a
 * consumer sharing one onTrace sink across concurrent runInline calls (e.g.
 * a long-lived otel.ts exporter) can always tell which call a given event
 * belongs to, even when two calls' windows overlap without nesting and they
 * happen to visit the exact same relative path.
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
 * `callId` (#366) disambiguates two *concurrent* nodes that share the exact
 * same `tag`/`name`/`path`/`runId` -- e.g. `sink.fanout(['a', 'a'])`, which
 * reaches `childPath(path, 'a')` twice at once. `path` alone only identifies
 * a *position* in the tree, not a specific physical async call, so a
 * consumer matching node-exit back to node-enter by position alone (e.g. by
 * always popping the topmost open entry for that path) can pair the wrong
 * exit with the wrong enter when two such calls finish out of push order.
 * `traced()` (src/runtime/inline.ts) mints one `callId` per invocation and
 * stamps it on both its node-enter and its node-exit, so a consumer can
 * match the specific pair by `callId` instead of by stack position.
 */
export type TraceEvent =
  | { kind: 'node-enter'; tag: string; name?: string; path: string; runId: string; callId: string }
  | { kind: 'node-exit'; tag: string; name?: string; path: string; runId: string; callId: string; durationMs: number; ok: boolean; error?: string }

export type TraceEventHandler = (e: TraceEvent) => void
