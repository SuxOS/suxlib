/**
 * Optional, no-op-by-default observability events for the Governor primitives
 * (circuit breaker, AIMD, token bucket, retry). Each primitive accepts an
 * `onEvent` callback in its constructor opts and calls it at its existing
 * state-transition points -- purely additive, never gates behavior.
 */
export type GovernorEvent =
  | { kind: 'breaker-open'; nowMs: number }
  | { kind: 'breaker-half-open'; nowMs: number }
  | { kind: 'breaker-close'; nowMs: number }
  | { kind: 'aimd-increase'; limit: number }
  | { kind: 'aimd-decrease'; limit: number }
  | { kind: 'token-wait'; attempt: number; delayMs: number }
  | { kind: 'retry-attempt'; name: string; attempt: number; delayMs: number }

export type GovernorEventHandler = (e: GovernorEvent) => void
