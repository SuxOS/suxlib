import { test, expect } from 'vitest'
import { op, pipe } from '../../src/op/combinators.js'
import { runInline } from '../../src/runtime/inline.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'
import { CircuitOpenError } from '../../src/control/governor.js'
import { fixed } from '../../src/control/aimd.js'

test('runInline retries a leaf per LeafOpts.retries until it succeeds', async () => {
  let calls = 0
  const leaf = op('flaky', async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok' }, { kind: 'effect', retries: 3 })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const result = await runInline(leaf, null, caps)
  expect(result).toBe('ok')
  expect(calls).toBe(3)
})

test('runInline gates an effect leaf through caps.governors[name].circuitBreaker', async () => {
  let calls = 0
  const leaf = op('guarded', async () => { calls++; return 'ok' }, { kind: 'effect' })
  const breaker = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1 })
  breaker.onFailure(0) // trips open
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {}, governors: { guarded: { circuitBreaker: breaker } } }
  await expect(runInline(leaf, null, caps)).rejects.toThrow(CircuitOpenError)
  expect(calls).toBe(0)
})

test('runInline leaves an ungoverned leaf (no caps.governors entry) to run exactly once as before', async () => {
  let calls = 0
  const leaf = op('plain', async (v: number) => { calls++; return v + 1 }, { kind: 'effect' })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const result = await runInline(leaf, 41, caps)
  expect(result).toBe(42)
  expect(calls).toBe(1)
})

test('runInline forwards gOpts to runGoverned: onEvent fires and custom sleep/rand are honored', async () => {
  let calls = 0
  const leaf = op('flaky', async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok' }, { kind: 'effect', retries: 3 })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const events: any[] = []
  const sleeps: number[] = []
  const result = await runInline(leaf, null, caps, {
    onEvent: (e) => events.push(e),
    sleep: async (ms) => { sleeps.push(ms) },
    rand: () => 0,
  })
  expect(result).toBe('ok')
  expect(events).toEqual([
    { kind: 'retry-attempt', name: 'flaky', attempt: 0, delayMs: expect.any(Number) },
    { kind: 'retry-attempt', name: 'flaky', attempt: 1, delayMs: expect.any(Number) },
  ])
  expect(sleeps.length).toBe(2)
})

test('runInline forwards gOpts through pipe and map recursion', async () => {
  let calls = 0
  const leaf = op('flaky', async () => { calls++; if (calls < 2) throw new Error('flaky'); return 'ok' }, { kind: 'effect', retries: 2 })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const events: any[] = []
  const tree = pipe(leaf)
  const result = await runInline(tree, null, caps, { onEvent: (e) => events.push(e), sleep: async () => {} })
  expect(result).toBe('ok')
  expect(events).toEqual([{ kind: 'retry-attempt', name: 'flaky', attempt: 0, delayMs: expect.any(Number) }])
})

test('runInline gates an effect leaf through caps.governors[name].concurrency, never exceeding its limit', async () => {
  const limiter = fixed(1)
  let inFlight = 0, maxInFlight = 0
  const leaf = op('bounded', async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    await Promise.resolve()
    inFlight--
    return 'ok'
  }, { kind: 'effect' })
  const caps: any = { store: {}, llm: {}, clock: { now: () => 0 }, sinks: {}, governors: { bounded: { concurrency: limiter } } }
  await Promise.all([runInline(leaf, null, caps), runInline(leaf, null, caps), runInline(leaf, null, caps)])
  expect(maxInFlight).toBe(1)
})
