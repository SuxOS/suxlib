import { test, expect } from 'vitest'
import { runGoverned, CircuitOpenError } from '../../src/control/governor.js'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'

function caps(now = 0): any {
  return { store: {}, llm: {}, clock: { now: () => now }, sinks: {} }
}
const noSleep = { sleep: async () => {}, rand: () => 0 }

test('retries an effect leaf up to LeafOpts.retries with full-jitter backoff, then succeeds', async () => {
  let calls = 0
  const fn = async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok' }
  const sleeps: number[] = []
  const result = await runGoverned('leaf', { kind: 'effect', retries: 3 }, fn, null, caps(), undefined, {
    ...noSleep, sleep: async (ms) => { sleeps.push(ms) },
  })
  expect(result).toBe('ok')
  expect(calls).toBe(3)
  expect(sleeps.length).toBe(2)
})

test('rethrows the original error once retries are exhausted', async () => {
  const fn = async () => { throw new Error('always fails') }
  await expect(
    runGoverned('leaf', { kind: 'effect', retries: 2 }, fn, null, caps(), undefined, noSleep),
  ).rejects.toThrow('always fails')
})

test('a leaf with no retries declared runs exactly once and rethrows on failure', async () => {
  let calls = 0
  const fn = async () => { calls++; throw new Error('nope') }
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), undefined, noSleep),
  ).rejects.toThrow('nope')
  expect(calls).toBe(1)
})

test('retries also apply to pure leaves (retries is a leaf-wide contract)', async () => {
  let calls = 0
  const fn = async () => { calls++; if (calls < 2) throw new Error('transient'); return 42 }
  const result = await runGoverned('leaf', { kind: 'pure', retries: 1 }, fn, null, caps(), undefined, noSleep)
  expect(result).toBe(42)
  expect(calls).toBe(2)
})

test('an open circuit breaker rejects an effect leaf before fn is ever called', async () => {
  let calls = 0
  const fn = async () => { calls++; return 'ok' }
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // trips open
  await expect(
    runGoverned('leaf', { kind: 'effect', retries: 5 }, fn, null, caps(0), { circuitBreaker: breaker }, noSleep),
  ).rejects.toThrow(CircuitOpenError)
  expect(calls).toBe(0)
})

test('the circuit breaker is not consulted for pure leaves', async () => {
  const fn = async () => 'ok'
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // trips open
  const result = await runGoverned('leaf', { kind: 'pure' }, fn, null, caps(0), { circuitBreaker: breaker }, noSleep)
  expect(result).toBe('ok')
})

test('a successful effect call reports onSuccess, closing the breaker after enough successes', async () => {
  const fn = async () => 'ok'
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open
  await runGoverned('leaf', { kind: 'effect' }, fn, null, caps(100), { circuitBreaker: breaker }, noSleep)
  expect(breaker.state).toBe('closed')
})

test('a failing effect call reports onFailure against the breaker', async () => {
  const fn = async () => { throw new Error('boom') }
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(0), { circuitBreaker: breaker }, noSleep),
  ).rejects.toThrow('boom')
  expect(breaker.state).toBe('open')
})

test('an effect leaf is rate-limited by the token bucket, draining it on each attempt', async () => {
  let simulatedNow = 0
  const clock = { now: () => simulatedNow }
  const bucket = tokenBucket({ capacity: 2, refillPerMs: 0, clock })
  const fn = async () => 'ok'
  await runGoverned('leaf', { kind: 'effect' }, fn, null, { ...caps(), clock }, { tokenBucket: bucket }, noSleep)
  expect(bucket.tokens).toBe(1)
})

test('the token bucket is not consulted for pure leaves', async () => {
  const bucket = tokenBucket({ capacity: 1, refillPerMs: 0, clock: { now: () => 0 } })
  bucket.tryTake(1, 0) // drain it
  const fn = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'pure' }, fn, null, caps(), { tokenBucket: bucket }, noSleep)
  expect(result).toBe('ok')
  expect(bucket.tokens).toBe(0) // untouched by the pure-leaf call
})
