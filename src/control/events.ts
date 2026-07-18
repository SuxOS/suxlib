// Observability events for the Governor primitives (circuit breaker, AIMD,
// retries). No-op by default -- nothing in this repo emits these unless a
// caller wires an `onEvent` handler into circuitBreaker()/aimd() opts or
// Governor.onEvent, keeping the dependency-light pure-core contract intact.
export type GovernorEvent =
  | { type: 'breaker-open'; nowMs: number }
  | { type: 'breaker-half-open'; nowMs: number }
  | { type: 'breaker-close'; nowMs: number }
  | { type: 'aimd-increase'; limit: number }
  | { type: 'aimd-decrease'; limit: number }
  | { type: 'retry'; leaf: string; attempt: number; err: unknown }

export type GovernorEventHandler = (e: GovernorEvent) => void
