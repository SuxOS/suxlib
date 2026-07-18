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
 */
export type GovernorEvent =
  | { kind: 'breaker-open'; nowMs: number; name?: string }
  | { kind: 'breaker-half-open'; nowMs: number; name?: string }
  | { kind: 'breaker-close'; nowMs: number; name?: string }
  | { kind: 'aimd-increase'; limit: number; name?: string }
  | { kind: 'aimd-decrease'; limit: number; name?: string }
  | { kind: 'token-wait'; attempt: number; delayMs: number; name?: string }
  | { kind: 'retry-attempt'; name: string; attempt: number; delayMs: number }
  | { kind: 'memo-hit'; name: string }
  | { kind: 'memo-miss'; name: string }

export type GovernorEventHandler = (e: GovernorEvent) => void
