/**
 * Optional, no-op-by-default observability events for the Governor primitives
 * (circuit breaker, AIMD, token bucket, retry). Each primitive accepts an
 * `onEvent` callback in its constructor opts and calls it at its existing
 * state-transition points -- purely additive, never gates behavior.
 *
 * `name` (the leaf name) is optional on every variant but `retry-attempt`
 * (which always has one, since runGoverned already knows it) because
 * circuitBreaker/aimd/tokenBucket are constructed standalone, with no leaf
 * concept of their own -- `createGovernor` (governor.ts) is what tags a
 * primitive's events with `name`, turning independently-wired `onEvent`
 * callbacks into one leaf-labeled stream.
 *
 * `runId` (#348, following #346's TraceEvent precedent) is optional on every
 * variant, for the same reason `name` is: circuitBreaker/aimd/tokenBucket are
 * built once per leaf and shared across every runInline call that leaf name
 * is reached from, so there's no single call-scoped id to bake in at
 * construction. Instead `runGoverned` (governor.ts) threads the calling
 * runInline's own runId through each primitive's gating method
 * (allow/onSuccess/onFailure/take/release) as a call argument, and each
 * primitive stamps it directly onto the event object it emits -- distinct
 * from `name`, which is tagged once at construction time via
 * `createGovernor`'s wrapper. This is what lets a shared onEvent sink (e.g.
 * src/adapters/otel.ts's exporters) attach a breaker/aimd/token-bucket event
 * to the exact run that produced it instead of falling back to "the
 * innermost span sharing that leaf name" when two concurrent runs share one
 * leaf.
 */
export type GovernorEvent =
  | { kind: 'breaker-open'; nowMs: number; name?: string; runId?: string }
  | { kind: 'breaker-half-open'; nowMs: number; name?: string; runId?: string }
  | { kind: 'breaker-close'; nowMs: number; name?: string; runId?: string }
  | { kind: 'aimd-increase'; limit: number; name?: string; runId?: string }
  | { kind: 'aimd-decrease'; limit: number; name?: string; runId?: string }
  | { kind: 'token-wait'; attempt: number; delayMs: number; name?: string; runId?: string }
  | { kind: 'retry-attempt'; name: string; attempt: number; delayMs: number; runId?: string }
  | { kind: 'memo-hit'; name: string; runId?: string }
  | { kind: 'memo-miss'; name: string; runId?: string }

export type GovernorEventHandler = (e: GovernorEvent) => void
