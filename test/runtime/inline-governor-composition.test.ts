import { test, expect } from 'vitest'
import { op } from '../../src/op/combinators.js'
import { runInline } from '../../src/runtime/inline.js'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'
import { aimd } from '../../src/control/aimd.js'
import { CircuitOpenError } from '../../src/control/governor.js'

// Closes the gap between "the composition is proven" (governor-simulation.test.ts's
// hand-rolled dispatch loop) and "the production wiring matches that proof": every
// test here drives a real op leaf through the actual runInline -> runGoverned call
// path, with a single Governor configuring all three §3.3 gates at once
// (circuitBreaker + tokenBucket + concurrency) plus LeafOpts.retries, rather than a
// synthetic simulation of the gates in isolation.

function caps(governor: { circuitBreaker?: any; tokenBucket?: any; concurrency?: any }): any {
  return { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {}, governors: { leaf: governor } }
}

test('a composed governor bounds concurrency and rate while retrying a flaky leaf to success', async () => {
  const breaker = circuitBreaker({ failureThreshold: 5, cooldownMs: 100, halfOpenSuccesses: 1 })
  const bucket = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  const limiter = aimd({ start: 2, min: 1, max: 8 })
  const c = caps({ circuitBreaker: breaker, tokenBucket: bucket, concurrency: limiter })

  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const leaf = op('leaf', async () => {
    calls++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await Promise.resolve()
    inFlight--
    if (calls < 3) throw new Error('flaky')
    return 'ok'
  }, { kind: 'effect', retries: 3 })

  const result = await runInline(leaf, null, c)

  expect(result).toBe('ok')
  expect(calls).toBe(3)
  expect(maxInFlight).toBe(1) // concurrency slot is re-acquired/released per attempt, never held across retries
  expect(bucket.tokens).toBe(10 - 3) // one token drawn per attempt, through the same gate every retry
  expect(breaker.state).toBe('closed') // final attempt succeeded, reported through the same breaker
})

test('a composed governor fails fast once the breaker trips, without ever reaching the effect', async () => {
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 50, halfOpenSuccesses: 1 })
  const bucket = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  const limiter = aimd({ start: 4, min: 1, max: 8 })
  const c = caps({ circuitBreaker: breaker, tokenBucket: bucket, concurrency: limiter })

  let calls = 0
  const failing = op('leaf', async () => { calls++; throw new Error('down') }, { kind: 'effect' })
  await expect(runInline(failing, null, c)).rejects.toThrow('down') // trips the breaker open
  expect(breaker.state).toBe('open')

  calls = 0
  const shouldNotRun = op('leaf', async () => { calls++; return 'unreachable' }, { kind: 'effect', retries: 5 })
  await expect(runInline(shouldNotRun, null, c)).rejects.toThrow(CircuitOpenError)
  expect(calls).toBe(0) // fails fast: neither the token bucket nor the effect is ever reached
  expect(bucket.tokens).toBe(10 - 1) // unchanged by the rejected call

  const recovering = op('leaf', async () => 'ok', { kind: 'effect' })
  const result = await runInline(recovering, null, { ...c, clock: { now: () => 50 } })
  expect(result).toBe('ok')
  expect(breaker.state).toBe('closed') // recovery: the half-open probe succeeded and closed the breaker
})

test('a composed governor caps concurrent half-open probes at one even when AIMD would allow more', async () => {
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 50, halfOpenSuccesses: 2 })
  const bucket = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  const limiter = aimd({ start: 4, min: 1, max: 8 }) // limit of 4 would otherwise admit both probes at once
  breaker.onFailure(0) // -> open
  const c = caps({ circuitBreaker: breaker, tokenBucket: bucket, concurrency: limiter })

  let inFlight = 0
  let maxInFlight = 0
  let releaseProbe!: () => void
  const probe = op('leaf', async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise<void>(resolve => { releaseProbe = resolve })
    inFlight--
    return 'ok'
  }, { kind: 'effect' })

  const halfOpenCaps = { ...c, clock: { now: () => 50 } } // cooldown elapsed -> half-open
  const first = runInline(probe, null, halfOpenCaps)
  await new Promise(resolve => setTimeout(resolve, 0)) // let the first probe reach the effect and block

  await expect(
    runInline(op('leaf', async () => 'should not run', { kind: 'effect' }), null, halfOpenCaps),
  ).rejects.toThrow(CircuitOpenError)

  releaseProbe()
  await expect(first).resolves.toBe('ok')
  expect(maxInFlight).toBe(1) // AIMD's limit of 4 never gets the chance to admit a second probe
})
