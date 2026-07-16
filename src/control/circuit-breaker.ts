export type BreakerState = 'closed' | 'open' | 'half-open'

export interface CircuitBreaker {
  readonly state: BreakerState
  allow(nowMs: number): boolean
  onSuccess(nowMs: number): void
  onFailure(nowMs: number): void
}

export function circuitBreaker(opts: {
  failureThreshold: number
  cooldownMs: number
  halfOpenSuccesses: number
}): CircuitBreaker {
  let state: BreakerState = 'closed'
  let consecutiveFailures = 0
  let consecutiveSuccesses = 0
  let openedAtMs = -Infinity

  return {
    get state() { return state },
    allow(nowMs) {
      if (state === 'open') {
        if (nowMs - openedAtMs >= opts.cooldownMs) {
          state = 'half-open'
          consecutiveSuccesses = 0
          return true
        }
        return false
      }
      return true
    },
    onSuccess(_nowMs) {
      if (state === 'half-open') {
        if (++consecutiveSuccesses >= opts.halfOpenSuccesses) {
          state = 'closed'
          consecutiveFailures = 0
          consecutiveSuccesses = 0
        }
        return
      }
      consecutiveFailures = 0
    },
    onFailure(nowMs) {
      if (state === 'half-open') {
        state = 'open'
        openedAtMs = nowMs
        consecutiveSuccesses = 0
        return
      }
      if (++consecutiveFailures >= opts.failureThreshold) {
        state = 'open'
        openedAtMs = nowMs
      }
    },
  }
}
