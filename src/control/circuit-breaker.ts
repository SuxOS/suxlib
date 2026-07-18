import type { GovernorEventHandler } from './events.js'

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface CircuitBreaker {
  readonly state: BreakerState
  allow(nowMs: number): boolean
  onSuccess(nowMs: number): void
  onFailure(nowMs: number): void
  // Caps concurrent half-open probes at one (spec §7's livelock guard). Owned by
  // the breaker itself rather than an external map keyed on instance identity, so
  // a durable CircuitBreaker (backing caps.governors for a future sux-side
  // runDurable) can implement these against persisted state instead — the
  // reservation then survives a probe attempt suspending across a step boundary
  // and resuming in a different isolate, which an in-process WeakMap could not.
  reserveHalfOpenProbe(): boolean
  releaseHalfOpenProbe(): void
}

export function circuitBreaker(opts: {
  failureThreshold: number
  cooldownMs: number
  halfOpenSuccesses: number
  onEvent?: GovernorEventHandler
}): CircuitBreaker {
  let state: BreakerState = 'closed'
  let consecutiveFailures = 0
  let consecutiveSuccesses = 0
  let openedAtMs = -Infinity
  let halfOpenProbeInFlight = false

  return {
    get state() { return state },
    reserveHalfOpenProbe() {
      if (halfOpenProbeInFlight) return false
      halfOpenProbeInFlight = true
      return true
    },
    releaseHalfOpenProbe() {
      halfOpenProbeInFlight = false
    },
    allow(nowMs) {
      if (state === 'open') {
        if (nowMs - openedAtMs >= opts.cooldownMs) {
          state = 'half-open'
          consecutiveSuccesses = 0
          opts.onEvent?.({ kind: 'breaker-half-open', nowMs })
          return true
        }
        return false
      }
      return true
    },
    onSuccess(nowMs) {
      if (state === 'half-open') {
        if (++consecutiveSuccesses >= opts.halfOpenSuccesses) {
          state = 'closed'
          consecutiveFailures = 0
          consecutiveSuccesses = 0
          opts.onEvent?.({ kind: 'breaker-close', nowMs })
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
        opts.onEvent?.({ kind: 'breaker-open', nowMs })
        return
      }
      if (++consecutiveFailures >= opts.failureThreshold) {
        state = 'open'
        openedAtMs = nowMs
        opts.onEvent?.({ kind: 'breaker-open', nowMs })
      }
    },
  }
}
