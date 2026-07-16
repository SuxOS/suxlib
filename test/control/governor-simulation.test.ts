import { describe, test, expect, beforeAll } from 'vitest'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'
import type { BreakerState } from '../../src/control/circuit-breaker.js'
import { aimd } from '../../src/control/aimd.js'
import { createFlakyDependency } from './fixtures/flaky-dependency.js'
import { createFakeClock } from './fixtures/fake-clock.js'

// Simulation constants. These are fixed governor tuning parameters, independent
// of the per-run burst-pattern matrix (seed/spikeHeight/outageDurationMs/costTokensPerCall).
const TICK_MS = 1
const SERVICE_TIME_MS = 3          // simulated time a call occupies a concurrency slot
const MAX_QUEUE = 200              // bounded-queue ceiling (property 2)
const QUIET_END_MS = 1000
const SPIKE_END_MS = 2000
const RECOVERY_TAIL_MS = 3000
const TOKEN_CAPACITY = 100
const TOKEN_REFILL_PER_MS = 5
const BREAKER_FAILURE_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 50
const BREAKER_HALF_OPEN_SUCCESSES = 3
const CONCURRENCY_REJECT_THRESHOLD = 8

interface QueuedCall { arrivalMs: number }
interface Completion { atMs: number; ok: boolean; wasHalfOpenProbe: boolean }
interface HalfOpenEpisode { probesSent: number; outcome: 'closed' | 'reopened' | 'ongoing' }

interface SimResult {
  totalTicks: number
  callsAttemptedToDependency: number
  callsRejectedByBreaker: number
  callsShedByFullQueue: number
  outageStartMs: number
  outageEndMs: number
  cooldownMs: number
  halfOpenSuccesses: number
  tokensConsumedInWindow: (windowStartMs: number, windowMs: number) => number
  maxQueueDepthObserved: number
  breakerStateAtTick: BreakerState[]
  aimdLimitAtTick: number[]
  attemptedAtTick: number[]
  rejectedByBreakerAtTick: number[]
  halfOpenEpisodes: HalfOpenEpisode[]
}

/**
 * Drives the §3.3 call-site pattern (breaker gate -> token gate -> concurrency
 * gate -> effect) against a seeded flaky dependency, entirely under a fake
 * clock, for a fixed-tick simulation covering quiet -> spike -> sustained
 * overload+outage -> recovery.
 *
 * Deliberate deviations from a literal transliteration of §3.3, both driven by
 * the plan's Task 1 design note (avoid real timers / unresolved async queues
 * inside a synchronous fake-clock loop) and noted here so they're visible:
 *
 * - Uses `tokenBucket.tryTake()`, never `take()` (matches Task 1's note).
 * - Concurrency admission is gated by reading `aimd.limit` and manually tracking
 *   in-flight count, then calling `aimd.release(ok)` on completion to drive the
 *   real AIMD adaptive-limit state machine — rather than calling `aimd.acquire()`,
 *   whose promise-queue would need real microtask interleaving to resolve
 *   in-order inside a synchronous per-tick loop. The AIMD *policy* under test
 *   (limit growth/halving) is exercised for real; only its queuing mechanism is
 *   replaced by this simulation's own bounded FIFO queue (below), which serves
 *   the same purpose (property 2 - no unbounded queue growth) for both gates at
 *   once instead of two separate unbounded promise queues.
 * - The call-site pattern adds one piece of policy not in either primitive
 *   individually: during 'half-open', at most one probe is allowed in flight at
 *   a time (spec §7's anticipated half-open/AIMD livelock risk is exactly this
 *   — circuitBreaker.allow() alone does not cap concurrent half-open probes, so
 *   the composition must, or an AIMD limit > 1 would let more than
 *   `halfOpenSuccesses` probes race through half-open at once).
 */
function runSimulation(params: { seed: number; spikeHeight: number; outageDurationMs: number; costTokensPerCall: number }): SimResult {
  const outageStartMs = SPIKE_END_MS
  const outageEndMs = SPIKE_END_MS + params.outageDurationMs
  const totalTicks = outageEndMs + RECOVERY_TAIL_MS

  const clock = createFakeClock(0)
  const bucket = tokenBucket({ capacity: TOKEN_CAPACITY, refillPerMs: TOKEN_REFILL_PER_MS, clock })
  const breaker = circuitBreaker({ failureThreshold: BREAKER_FAILURE_THRESHOLD, cooldownMs: BREAKER_COOLDOWN_MS, halfOpenSuccesses: BREAKER_HALF_OPEN_SUCCESSES })
  const limiter = aimd({ start: 4, min: 1, max: 64 })
  const dep = createFlakyDependency({
    seed: params.seed,
    concurrencyRejectThreshold: CONCURRENCY_REJECT_THRESHOLD,
    outageStartMs,
    outageEndMs,
    costTokensPerCall: params.costTokensPerCall,
  })

  let inflightCount = 0
  let halfOpenProbeInFlight = false
  const pendingQueue: QueuedCall[] = []
  const completions: Completion[] = []

  let callsAttemptedToDependency = 0
  let callsRejectedByBreaker = 0
  let callsShedByFullQueue = 0
  let maxQueueDepthObserved = 0
  const tokenConsumptions: Array<{ atMs: number; amount: number }> = []
  const breakerStateAtTick: BreakerState[] = []
  const aimdLimitAtTick: number[] = []
  const attemptedAtTick: number[] = []
  const rejectedByBreakerAtTick: number[] = []

  let prevBreakerState: BreakerState = breaker.state
  const halfOpenEpisodes: HalfOpenEpisode[] = []
  let currentEpisode: HalfOpenEpisode | null = null

  function arrivalsAtTick(tickMs: number): number {
    if (tickMs < QUIET_END_MS) return tickMs % 10 === 0 ? 1 : 0
    if (tickMs < outageEndMs) return params.spikeHeight
    return tickMs % 5 === 0 ? 1 : 0
  }

  // Dispatch outcome. `wasHalfOpenProbe` bookkeeping against `currentEpisode`
  // is deliberately done by the caller, inline in the tick loop below, NOT
  // here inside this nested function: a `let` reassigned only from inside a
  // nested closure loses its narrowed type for TypeScript's control-flow
  // analysis at the later `if (currentEpisode)` read sites in the tick loop
  // (they resolved to `never` when the mutation lived in a nested function) —
  // keeping every read/write of `currentEpisode` directly in the tick loop's
  // own scope keeps CFA, and the logic, correct. Verified in isolation: a
  // minimal repro of "mutate a captured `let` only inside a nested function,
  // then narrow it with a truthy check back in the outer scope" reproduces
  // the same `never` error; inlining the mutation into the outer scope fixes it.
  function dispatch(nowMs: number): { dispatched: boolean; wasHalfOpenProbe: boolean } {
    if (inflightCount >= limiter.limit) return { dispatched: false, wasHalfOpenProbe: false }
    if (!bucket.tryTake(params.costTokensPerCall, nowMs)) return { dispatched: false, wasHalfOpenProbe: false }
    const wasHalfOpenProbe = breaker.state === 'half-open'
    if (wasHalfOpenProbe) halfOpenProbeInFlight = true
    inflightCount++
    const concurrentInFlight = inflightCount - 1
    const res = dep.call(concurrentInFlight, nowMs)
    callsAttemptedToDependency++
    tokenConsumptions.push({ atMs: nowMs, amount: params.costTokensPerCall })
    completions.push({ atMs: nowMs + SERVICE_TIME_MS, ok: res.ok, wasHalfOpenProbe })
    return { dispatched: true, wasHalfOpenProbe }
  }

  // whether a call attempt is even allowed past the breaker right now
  function breakerPermits(nowMs: number): boolean {
    if (!breaker.allow(nowMs)) return false
    if (breaker.state === 'half-open' && halfOpenProbeInFlight) return false
    return true
  }

  for (let tickMs = 0; tickMs < totalTicks; tickMs += TICK_MS) {
    clock.set(tickMs)

    for (let i = completions.length - 1; i >= 0; i--) {
      const c = completions[i]
      if (c.atMs <= tickMs) {
        completions.splice(i, 1)
        inflightCount--
        limiter.release(c.ok)
        if (c.ok) breaker.onSuccess(tickMs); else breaker.onFailure(tickMs)
        if (c.wasHalfOpenProbe) halfOpenProbeInFlight = false
      }
    }

    // drain the bounded queue FIFO: re-check breaker permission (it may have
    // tripped open while these calls were waiting on tokens/concurrency), stop
    // at the first call that still can't be dispatched to preserve FIFO order.
    while (pendingQueue.length > 0) {
      if (!breakerPermits(tickMs)) { pendingQueue.shift(); callsRejectedByBreaker++; continue }
      const d = dispatch(tickMs)
      if (!d.dispatched) break
      // Lazy episode creation: the probe that *causes* the open->half-open
      // transition (via breaker.allow() inside breakerPermits(), above) is
      // dispatched in the same tick as the transition, before the end-of-tick
      // sweep below would see it — so the episode must open here, at
      // first-probe time, not deferred to that sweep, or this probe is lost
      // from its own episode's count.
      if (d.wasHalfOpenProbe) {
        if (!currentEpisode) currentEpisode = { probesSent: 0, outcome: 'ongoing' }
        currentEpisode.probesSent++
      }
      pendingQueue.shift()
    }

    let attemptedThisTick = 0
    let rejectedThisTick = 0
    const arrivals = arrivalsAtTick(tickMs)
    for (let i = 0; i < arrivals; i++) {
      if (!breakerPermits(tickMs)) { callsRejectedByBreaker++; rejectedThisTick++; continue }
      if (pendingQueue.length === 0) {
        const d = dispatch(tickMs)
        if (d.dispatched) {
          if (d.wasHalfOpenProbe) {
            if (!currentEpisode) currentEpisode = { probesSent: 0, outcome: 'ongoing' }
            currentEpisode.probesSent++
          }
          attemptedThisTick++
          continue
        }
      }
      if (pendingQueue.length < MAX_QUEUE) pendingQueue.push({ arrivalMs: tickMs })
      else callsShedByFullQueue++
    }
    attemptedAtTick.push(attemptedThisTick)
    rejectedByBreakerAtTick.push(rejectedThisTick)

    maxQueueDepthObserved = Math.max(maxQueueDepthObserved, pendingQueue.length)
    breakerStateAtTick.push(breaker.state)
    aimdLimitAtTick.push(limiter.limit)

    if (prevBreakerState !== breaker.state) {
      if (prevBreakerState === 'half-open' && breaker.state === 'closed' && currentEpisode) {
        currentEpisode.outcome = 'closed'
        halfOpenEpisodes.push(currentEpisode)
        currentEpisode = null
      } else if (prevBreakerState === 'half-open' && breaker.state === 'open' && currentEpisode) {
        currentEpisode.outcome = 'reopened'
        halfOpenEpisodes.push(currentEpisode)
        currentEpisode = null
      }
      prevBreakerState = breaker.state
    }
  }

  return {
    totalTicks,
    callsAttemptedToDependency,
    callsRejectedByBreaker,
    callsShedByFullQueue,
    outageStartMs,
    outageEndMs,
    cooldownMs: BREAKER_COOLDOWN_MS,
    halfOpenSuccesses: BREAKER_HALF_OPEN_SUCCESSES,
    tokensConsumedInWindow: (windowStartMs, windowMs) =>
      tokenConsumptions
        .filter((c) => c.atMs >= windowStartMs && c.atMs < windowStartMs + windowMs)
        .reduce((sum, c) => sum + c.amount, 0),
    maxQueueDepthObserved,
    breakerStateAtTick,
    aimdLimitAtTick,
    attemptedAtTick,
    rejectedByBreakerAtTick,
    halfOpenEpisodes,
  }
}

describe('governor composition — token-bucket + AIMD + circuit-breaker', () => {
  const matrix = [
    { seed: 1, spikeHeight: 10, outageDurationMs: 200, costTokensPerCall: 5 },
    { seed: 2, spikeHeight: 50, outageDurationMs: 500, costTokensPerCall: 1 },
    { seed: 3, spikeHeight: 5, outageDurationMs: 1000, costTokensPerCall: 20 },
  ]

  for (const params of matrix) {
    describe(`params=${JSON.stringify(params)}`, () => {
      let result: SimResult
      beforeAll(() => { result = runSimulation(params) })

      test('property 1: bounded spend rate — never exceeds capacity + refill over any sampled window', () => {
        const windowMs = 100
        for (let w = 0; w < result.totalTicks; w += windowMs) {
          const consumed = result.tokensConsumedInWindow(w, windowMs)
          expect(consumed).toBeLessThanOrEqual(TOKEN_CAPACITY + TOKEN_REFILL_PER_MS * windowMs)
        }
      })

      test('property 2: no unbounded queue growth', () => {
        expect(result.maxQueueDepthObserved).toBeLessThanOrEqual(MAX_QUEUE)
        expect(result.maxQueueDepthObserved).toBeGreaterThan(0) // sanity: queueing actually happened under this burst pattern
      })

      test('property 3: recovery after the overload/outage window within a bounded number of ticks', () => {
        const RECOVERY_BOUND_TICKS = 500
        const checkAt = Math.min(result.totalTicks - 1, result.outageEndMs + RECOVERY_BOUND_TICKS)
        expect(result.breakerStateAtTick[checkAt]).toBe('closed')
        expect(result.aimdLimitAtTick[checkAt]).toBeGreaterThan(1) // not stuck at the floor
      })

      test('property 4: fail-fast during the outage — dependency-attempt fraction drops near zero', () => {
        const windowStart = result.outageStartMs + result.cooldownMs
        const windowEnd = Math.min(result.outageEndMs, windowStart + result.cooldownMs * 4)
        let attempted = 0, rejected = 0
        for (let t = windowStart; t < windowEnd; t++) {
          attempted += result.attemptedAtTick[t] ?? 0
          rejected += result.rejectedByBreakerAtTick[t] ?? 0
        }
        expect(attempted + rejected).toBeGreaterThan(0) // sanity: traffic was actually offered in this window
        const attemptFraction = attempted / (attempted + rejected)
        expect(attemptFraction).toBeLessThan(0.1)
      })

      test('property 5: half-open probe count matches halfOpenSuccesses regardless of AIMD limit', () => {
        const closedEpisodes = result.halfOpenEpisodes.filter((e) => e.outcome === 'closed')
        expect(closedEpisodes.length).toBeGreaterThan(0) // sanity: recovery actually happened
        for (const ep of closedEpisodes) {
          expect(ep.probesSent).toBe(result.halfOpenSuccesses)
        }
      })
    })
  }
})
