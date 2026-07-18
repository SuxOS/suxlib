import { test, expect } from 'vitest'
import { runGoverned, CircuitOpenError } from '../../src/control/governor.js'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'
import { fixed, aimd } from '../../src/control/aimd.js'

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

test('reports a retry event per attempt via governor.onEvent, but not after retries are exhausted', async () => {
  let calls = 0
  const fn = async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok' }
  const events: any[] = []
  const result = await runGoverned('leaf', { kind: 'effect', retries: 3 }, fn, null, caps(), { onEvent: e => events.push(e) }, noSleep)
  expect(result).toBe('ok')
  expect(events).toEqual([
    { type: 'retry', leaf: 'leaf', attempt: 0, err: expect.any(Error) },
    { type: 'retry', leaf: 'leaf', attempt: 1, err: expect.any(Error) },
  ])
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

test('caps a half-open breaker to one in-flight probe: a concurrent second call is rejected, not raced through', async () => {
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open

  let inFlight = 0
  let maxInFlight = 0
  let releaseProbe!: () => void
  const fn = async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise<void>(resolve => { releaseProbe = resolve })
    inFlight--
    return 'ok'
  }

  const first = runGoverned('leaf', { kind: 'effect' }, fn, null, caps(100), { circuitBreaker: breaker }, noSleep)
  await new Promise(resolve => setTimeout(resolve, 0)) // let the first probe reach fn and block

  await expect(
    runGoverned('leaf', { kind: 'effect' }, async () => 'should not run', null, caps(100), { circuitBreaker: breaker }, noSleep),
  ).rejects.toThrow(CircuitOpenError)

  releaseProbe()
  await expect(first).resolves.toBe('ok')
  expect(maxInFlight).toBe(1)
})

test('releases the half-open probe slot after a failed attempt, so a subsequent call can probe again', async () => {
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open

  const failing = async () => { throw new Error('still down') }
  await expect(
    runGoverned('leaf', { kind: 'effect' }, failing, null, caps(100), { circuitBreaker: breaker }, noSleep),
  ).rejects.toThrow('still down')
  expect(breaker.state).toBe('open') // failed probe reopens the breaker

  breaker.allow(300) // cooldown elapsed again -> half-open
  const succeeding = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'effect' }, succeeding, null, caps(300), { circuitBreaker: breaker }, noSleep)
  expect(result).toBe('ok')
  expect(breaker.state).toBe('closed')
})

test('releases the half-open probe slot when the token bucket throws, so a subsequent call can probe again', async () => {
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open

  const throwingBucket = { take: async () => { throw new Error('rate limiter unavailable') } }
  const fn = async () => 'should not run'
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(100), { circuitBreaker: breaker, tokenBucket: throwingBucket as any }, noSleep),
  ).rejects.toThrow('rate limiter unavailable')
  expect(breaker.state).toBe('open') // failed probe reopens the breaker, reporting onFailure too

  breaker.allow(300) // cooldown elapsed again -> half-open
  const succeeding = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'effect' }, succeeding, null, caps(300), { circuitBreaker: breaker }, noSleep)
  expect(result).toBe('ok')
  expect(breaker.state).toBe('closed')
})

test('passes a stable idempotencyKey to the leaf fn on every retry attempt', async () => {
  const seen: (string | undefined)[] = []
  let calls = 0
  const fn = async (_input: any, _caps: any, idemKey?: string) => {
    calls++
    seen.push(idemKey)
    if (calls < 3) throw new Error('flaky')
    return 'ok'
  }
  const result = await runGoverned('leaf', { kind: 'effect', retries: 3 }, fn, { a: 1 }, caps(), undefined, noSleep)
  expect(result).toBe('ok')
  expect(seen.length).toBe(3)
  expect(seen.every(k => typeof k === 'string' && k === seen[0])).toBe(true)
})

test('does not compute an idempotencyKey for pure leaves', async () => {
  let seenKey: string | undefined = 'not-called'
  const fn = async (_input: any, _caps: any, idemKey?: string) => { seenKey = idemKey; return 'ok' }
  await runGoverned('leaf', { kind: 'pure' }, fn, { a: 1 }, caps(), undefined, noSleep)
  expect(seenKey).toBeUndefined()
})

test('gates an effect leaf through governor.concurrency, never exceeding its limit', async () => {
  const limiter = fixed(1)
  let inFlight = 0, maxInFlight = 0
  const fn = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    await Promise.resolve()
    inFlight--
    return 'ok'
  }
  await Promise.all([
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { concurrency: limiter }, noSleep),
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { concurrency: limiter }, noSleep),
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { concurrency: limiter }, noSleep),
  ])
  expect(maxInFlight).toBe(1)
})

test('concurrency is not consulted for pure leaves', async () => {
  const limiter = fixed(1)
  let acquireCalls = 0
  const spy = { acquire: async () => { acquireCalls++; await limiter.acquire() }, release: (ok: boolean) => limiter.release(ok) }
  const fn = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'pure' }, fn, null, caps(), { concurrency: spy }, noSleep)
  expect(result).toBe('ok')
  expect(acquireCalls).toBe(0)
})

test('reports failure to an AIMD concurrency limiter on a rejected attempt, halving its limit', async () => {
  const limiter = aimd({ start: 8, min: 1 })
  const fn = async () => { throw new Error('boom') }
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { concurrency: limiter }, noSleep),
  ).rejects.toThrow('boom')
  expect(limiter.limit).toBe(4)
})

test('releases the concurrency slot when the token bucket throws, without ever acquiring it', async () => {
  const limiter = fixed(1)
  let acquireCalls = 0
  const spy = { acquire: async () => { acquireCalls++; await limiter.acquire() }, release: (ok: boolean) => limiter.release(ok) }
  const throwingBucket = { take: async () => { throw new Error('rate limiter unavailable') } }
  const fn = async () => 'should not run'
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { tokenBucket: throwingBucket as any, concurrency: spy }, noSleep),
  ).rejects.toThrow('rate limiter unavailable')
  expect(acquireCalls).toBe(0)
})
