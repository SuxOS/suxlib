import { test, expect } from 'vitest'
import { runGoverned, createGovernor, CircuitOpenError, OpAbortError } from '../../src/control/governor.js'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'
import { fixed, aimd } from '../../src/control/aimd.js'
import { MemoryCache } from '../../src/effects/types.js'

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

test('emits a retry-attempt event before each backoff sleep', async () => {
  let calls = 0
  const fn = async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok' }
  const events: any[] = []
  const result = await runGoverned('leaf', { kind: 'effect', retries: 3 }, fn, null, caps(), undefined, {
    ...noSleep, onEvent: (e) => events.push(e),
  })
  expect(result).toBe('ok')
  expect(events).toEqual([
    { kind: 'retry-attempt', name: 'leaf', attempt: 0, delayMs: expect.any(Number) },
    { kind: 'retry-attempt', name: 'leaf', attempt: 1, delayMs: expect.any(Number) },
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

test('a starved token bucket waits via the injected sleep, not a real setTimeout', async () => {
  let simulatedNow = 0
  const clock = { now: () => simulatedNow }
  const bucket = tokenBucket({ capacity: 1, refillPerMs: 1, clock })
  bucket.tryTake(1, 0) // drain it
  const fn = async () => 'ok'
  const sleepCalls: number[] = []
  const sleep = async (ms: number) => { sleepCalls.push(ms); simulatedNow += ms }
  const result = await runGoverned('leaf', { kind: 'effect' }, fn, null, { ...caps(), clock }, { tokenBucket: bucket }, { ...noSleep, sleep })
  expect(result).toBe('ok')
  expect(sleepCalls.length).toBeGreaterThan(0)
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

test('releases the half-open probe slot before the retry backoff sleep, not after it', async () => {
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open

  let releaseSleep!: () => void
  const blockingSleep = () => new Promise<void>(resolve => { releaseSleep = resolve })
  const failing = async () => { throw new Error('still down') }

  const run = runGoverned('leaf', { kind: 'effect', retries: 1 }, failing, null, caps(100), { circuitBreaker: breaker }, { sleep: blockingSleep })
  await new Promise(resolve => setTimeout(resolve, 0)) // let the probe fail and reach the backoff sleep

  // The probe already failed and released its slot -- a concurrent call should be able to
  // reserve a new probe immediately, without waiting for the sleeping attempt to finish.
  expect(breaker.reserveHalfOpenProbe()).toBe(true)
  breaker.releaseHalfOpenProbe()

  releaseSleep()
  // The retry attempt after the sleep re-checks the breaker at the same clock time as the
  // failed probe, so it's immediately circuit-open again -- not the point under test, which
  // is that the probe slot was already free *during* the sleep, above.
  await expect(run).rejects.toThrow(CircuitOpenError)
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

test('does not compute an idempotencyKey for an effect leaf with no retries -- nothing to dedupe', async () => {
  let seenKey: string | undefined = 'not-called'
  const fn = async (_input: any, _caps: any, idemKey?: string) => { seenKey = idemKey; return 'ok' }
  await runGoverned('leaf', { kind: 'effect' }, fn, { a: 1 }, caps(), undefined, noSleep)
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

test('a heavy effect leaf is gated through governor.heavyConcurrency instead of governor.concurrency', async () => {
  const normal = fixed(4)
  let heavyAcquireCalls = 0
  const heavy = { acquire: async () => { heavyAcquireCalls++; await normal.acquire() }, release: (ok: boolean) => normal.release(ok) }
  let normalAcquireCalls = 0
  const spyNormal = { acquire: async () => { normalAcquireCalls++ }, release: () => {} }
  const fn = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'effect', heavy: true }, fn, null, caps(), { concurrency: spyNormal, heavyConcurrency: heavy }, noSleep)
  expect(result).toBe('ok')
  expect(heavyAcquireCalls).toBe(1)
  expect(normalAcquireCalls).toBe(0)
})

test('a heavy effect leaf falls back to governor.concurrency when no heavyConcurrency is configured', async () => {
  const limiter = fixed(1)
  let acquireCalls = 0
  const spy = { acquire: async () => { acquireCalls++; await limiter.acquire() }, release: (ok: boolean) => limiter.release(ok) }
  const fn = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'effect', heavy: true }, fn, null, caps(), { concurrency: spy }, noSleep)
  expect(result).toBe('ok')
  expect(acquireCalls).toBe(1)
})

test('a non-heavy effect leaf is not consulted against governor.heavyConcurrency', async () => {
  let heavyAcquireCalls = 0
  const heavy = { acquire: async () => { heavyAcquireCalls++ }, release: () => {} }
  const fn = async () => 'ok'
  const result = await runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { heavyConcurrency: heavy }, noSleep)
  expect(result).toBe('ok')
  expect(heavyAcquireCalls).toBe(0)
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

test('createGovernor tags breaker/aimd/tokenBucket events from one shared onEvent with the leaf name', async () => {
  const events: any[] = []
  const governor = createGovernor('leaf-a', {
    circuitBreaker: { failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 },
    tokenBucket: { capacity: 1, refillPerMs: 0, clock: { now: () => 0 } },
    concurrency: { kind: 'aimd', start: 1, min: 1, max: 2 },
  }, e => events.push(e))

  governor.circuitBreaker!.onFailure(0) // -> open, emits breaker-open
  governor.concurrency!.release(true) // successes >= limit(1) -> aimd-increase

  expect(events).toEqual([
    { kind: 'breaker-open', nowMs: 0, name: 'leaf-a' },
    { kind: 'aimd-increase', limit: 2, name: 'leaf-a' },
  ])
})

test('createGovernor with no onEvent leaves the primitives silently unwired', async () => {
  const governor = createGovernor('leaf-a', {
    circuitBreaker: { failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 },
  })
  expect(() => governor.circuitBreaker!.onFailure(0)).not.toThrow()
  expect(governor.circuitBreaker!.state).toBe('open')
})

test('createGovernor builds a fixed concurrency limiter (no events, since its limit never changes)', async () => {
  const events: any[] = []
  const governor = createGovernor('leaf-a', { concurrency: { kind: 'fixed', n: 1 } }, e => events.push(e))
  let inFlight = 0, maxInFlight = 0
  const run = async () => { await governor.concurrency!.acquire(); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); inFlight--; governor.concurrency!.release(true) }
  await Promise.all([run(), run()])
  expect(maxInFlight).toBe(1)
  expect(events).toEqual([])
})

test('createGovernor wires a heavyConcurrency limiter distinct from concurrency', async () => {
  const governor = createGovernor('leaf-a', {
    concurrency: { kind: 'fixed', n: 4 },
    heavyConcurrency: { kind: 'fixed', n: 1 },
  })
  expect(governor.concurrency).not.toBe(governor.heavyConcurrency)
})

test('createGovernor composed with runInline-style dispatch: retry-attempt and breaker events share one name-tagged stream', async () => {
  const events: any[] = []
  const governor = createGovernor('flaky-leaf', {
    circuitBreaker: { failureThreshold: 5, cooldownMs: 100, halfOpenSuccesses: 1 },
  }, e => events.push(e))

  let calls = 0
  const fn = async () => { calls++; if (calls < 2) throw new Error('flaky'); return 'ok' }
  const result = await runGoverned('flaky-leaf', { kind: 'effect', retries: 2 }, fn, null, caps(), governor, {
    ...noSleep,
    onEvent: e => events.push(e),
  })

  expect(result).toBe('ok')
  expect(events).toEqual([
    { kind: 'retry-attempt', name: 'flaky-leaf', attempt: 0, delayMs: expect.any(Number) },
  ])
})

test('a memo leaf calls fn once for repeated identical input, serving later calls from caps.cache', async () => {
  let calls = 0
  const fn = async (input: any) => { calls++; return { handle: input } }
  const c = { ...caps(), cache: new MemoryCache() }
  const first = await runGoverned('shrink', { kind: 'pure', memo: true }, fn, { a: 1 }, c, undefined, noSleep)
  const second = await runGoverned('shrink', { kind: 'pure', memo: true }, fn, { a: 1 }, c, undefined, noSleep)
  expect(calls).toBe(1)
  expect(second).toEqual(first)
})

test('a memo leaf recomputes for a different input, keeping both results cached', async () => {
  let calls = 0
  const fn = async (input: any) => { calls++; return { handle: input } }
  const c = { ...caps(), cache: new MemoryCache() }
  await runGoverned('shrink', { kind: 'pure', memo: true }, fn, { a: 1 }, c, undefined, noSleep)
  await runGoverned('shrink', { kind: 'pure', memo: true }, fn, { a: 2 }, c, undefined, noSleep)
  expect(calls).toBe(2)
})

test('memo is a no-op without caps.cache: fn runs on every call', async () => {
  let calls = 0
  const fn = async () => { calls++; return 'ok' }
  await runGoverned('shrink', { kind: 'pure', memo: true }, fn, { a: 1 }, caps(), undefined, noSleep)
  await runGoverned('shrink', { kind: 'pure', memo: true }, fn, { a: 1 }, caps(), undefined, noSleep)
  expect(calls).toBe(2)
})

test('a memo cache hit skips retries/breaker/concurrency entirely', async () => {
  const fn = async () => 'ok'
  const c = { ...caps(), cache: new MemoryCache() }
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // trips open -- would reject a real attempt
  await runGoverned('shrink', { kind: 'effect', memo: true }, fn, null, { ...c, clock: { now: () => 0 } }, undefined, noSleep)
  const result = await runGoverned('shrink', { kind: 'effect', memo: true }, fn, null, { ...c, clock: { now: () => 0 } }, { circuitBreaker: breaker }, noSleep)
  expect(result).toBe('ok')
})

test('emits memo-miss then memo-hit events across two calls with identical input', async () => {
  const fn = async () => 'ok'
  const c = { ...caps(), cache: new MemoryCache() }
  const events: any[] = []
  await runGoverned('shrink', { kind: 'pure', memo: true }, fn, null, c, undefined, { ...noSleep, onEvent: e => events.push(e) })
  await runGoverned('shrink', { kind: 'pure', memo: true }, fn, null, c, undefined, { ...noSleep, onEvent: e => events.push(e) })
  expect(events).toEqual([
    { kind: 'memo-miss', name: 'shrink' },
    { kind: 'memo-hit', name: 'shrink' },
  ])
})

test('a failed attempt is not cached: a later call retries fn', async () => {
  let calls = 0
  const fn = async () => { calls++; throw new Error('boom') }
  const c = { ...caps(), cache: new MemoryCache() }
  await expect(runGoverned('shrink', { kind: 'pure', memo: true }, fn, null, c, undefined, noSleep)).rejects.toThrow('boom')
  await expect(runGoverned('shrink', { kind: 'pure', memo: true }, fn, null, c, undefined, noSleep)).rejects.toThrow('boom')
  expect(calls).toBe(2)
})

test('a throw from post-success bookkeeping (e.g. breaker onSuccess -> onEvent) propagates without double-releasing the concurrency slot or reopening the breaker (#275)', async () => {
  const releases: boolean[] = []
  const concurrency = {
    async acquire() {},
    release(ok: boolean) { releases.push(ok) },
  }
  const breaker = circuitBreaker({
    failureThreshold: 1,
    cooldownMs: 100,
    halfOpenSuccesses: 1,
    onEvent: (e) => { if (e.kind === 'breaker-close') throw new Error('host onEvent boom') },
  })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open
  const fn = async () => 'ok'
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(100), { circuitBreaker: breaker, concurrency }, noSleep),
  ).rejects.toThrow('host onEvent boom')
  // The leaf itself succeeded and the breaker legitimately closed -- the throw
  // came from bookkeeping *after* that, so it must not be reclassified as a
  // leaf failure: exactly one release (the success release), not a second
  // failure release, and the breaker must stay closed, not reopen.
  expect(releases).toEqual([true])
  expect(breaker.state).toBe('closed')
})

test('an already-aborted signal rejects with OpAbortError before fn is ever called (#279)', async () => {
  let calls = 0
  const fn = async () => { calls++; return 'ok' }
  const controller = new AbortController()
  controller.abort()
  await expect(
    runGoverned('leaf', { kind: 'effect', retries: 3 }, fn, null, caps(), undefined, { ...noSleep, signal: controller.signal }),
  ).rejects.toThrow(OpAbortError)
  expect(calls).toBe(0)
})

test('aborting mid-retry stops a subsequent attempt from starting', async () => {
  let calls = 0
  const fn = async () => { calls++; throw new Error('flaky') }
  const controller = new AbortController()
  const sleep = async () => { controller.abort() } // fires between the first failed attempt and its retry
  await expect(
    runGoverned('leaf', { kind: 'effect', retries: 5 }, fn, null, caps(), undefined, { rand: () => 0, sleep, signal: controller.signal }),
  ).rejects.toThrow(OpAbortError)
  expect(calls).toBe(1)
})

test('aborting during the backoff sleep rejects immediately, without waiting out the full delay', async () => {
  const fn = async () => { throw new Error('flaky') }
  const controller = new AbortController()
  const blockingSleep = () => new Promise<void>(() => {}) // never resolves on its own
  const run = runGoverned('leaf', { kind: 'effect', retries: 5 }, fn, null, caps(), undefined, { rand: () => 0, sleep: blockingSleep, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 0)) // let the first attempt fail and reach the backoff sleep
  controller.abort()
  await expect(run).rejects.toThrow(OpAbortError)
})

test('aborting while queued behind a starved token bucket rejects immediately (#297)', async () => {
  let calls = 0
  const fn = async () => { calls++; return 'ok' }
  const bucket = tokenBucket({ capacity: 1, refillPerMs: 0, clock: { now: () => 0 } })
  bucket.tryTake(1, 0) // drain it, so the leaf's own take() must wait
  const controller = new AbortController()
  const blockingSleep = () => new Promise<void>(() => {}) // never resolves on its own
  const run = runGoverned('leaf', { kind: 'effect' }, fn, null, caps(), { tokenBucket: bucket }, { sleep: blockingSleep, signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  await expect(run).rejects.toThrow(OpAbortError)
  expect(calls).toBe(0)
})

test('aborting while queued behind a full concurrency limiter rejects immediately, without polluting the breaker or emitting a retry-attempt event (#297)', async () => {
  let calls = 0
  const fn = async () => { calls++; return 'ok' }
  const concurrency = fixed(1)
  await concurrency.acquire() // hold the only slot so the leaf's own acquire() must wait
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  const events: any[] = []
  const controller = new AbortController()
  const run = runGoverned('leaf', { kind: 'effect', retries: 5 }, fn, null, caps(), { circuitBreaker: breaker, concurrency }, { rand: () => 0, onEvent: (e) => events.push(e), signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  await expect(run).rejects.toThrow(OpAbortError)
  expect(calls).toBe(0)
  expect(events).toEqual([])           // no spurious retry-attempt event
  expect(breaker.state).toBe('closed') // abort must not be misclassified as a leaf failure
})

test('a throw from post-success bookkeeping does not permanently strand the half-open probe reservation (#290)', async () => {
  const concurrency = { async acquire() {}, release() {} }
  const breaker = circuitBreaker({
    failureThreshold: 1,
    cooldownMs: 100,
    halfOpenSuccesses: 1,
    onEvent: (e) => { if (e.kind === 'breaker-close') throw new Error('host onEvent boom') },
  })
  breaker.onFailure(0) // -> open
  breaker.allow(100)   // cooldown elapsed -> half-open
  const fn = async () => 'ok'
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(100), { circuitBreaker: breaker, concurrency }, noSleep),
  ).rejects.toThrow('host onEvent boom')
  expect(breaker.state).toBe('closed')
  // Drive the breaker open and back into half-open again -- if the earlier
  // throw had skipped releaseHalfOpenProbe(), reserveHalfOpenProbe() would
  // return false forever and every future call would throw CircuitOpenError
  // immediately, even once cooldown has legitimately elapsed.
  breaker.onFailure(200) // -> open
  breaker.allow(300)     // cooldown elapsed -> half-open
  // If the probe reservation were stranded, this would throw CircuitOpenError
  // (from reserveHalfOpenProbe() returning false) before fn ever runs, instead
  // of the host onEvent's own throw from the *second* legitimate close.
  await expect(
    runGoverned('leaf', { kind: 'effect' }, fn, null, caps(300), { circuitBreaker: breaker, concurrency }, noSleep),
  ).rejects.toThrow('host onEvent boom')
})
