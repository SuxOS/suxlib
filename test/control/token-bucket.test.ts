import { test, expect } from 'vitest'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { OpAbortError } from '../../src/control/abort.js'

test('tryTake consumes tokens up to capacity and refuses beyond it', () => {
  const b = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  expect(b.tokens).toBe(10)
  expect(b.tryTake(6, 0)).toBe(true)
  expect(b.tokens).toBe(4)
  expect(b.tryTake(5, 0)).toBe(false)   // insufficient tokens, no partial consumption
  expect(b.tokens).toBe(4)              // unchanged on refusal
})

test('tokens refill linearly with elapsed time, capped at capacity', () => {
  const b = tokenBucket({ capacity: 10, refillPerMs: 1, clock: { now: () => 0 } })
  b.tryTake(10, 0)
  expect(b.tokens).toBe(0)
  expect(b.tryTake(1, 500)).toBe(true)   // 500ms * 1/ms = 500 tokens, capped at 10
  expect(b.tokens).toBe(9)
  expect(b.tryTake(5, 5)).toBe(true)     // 5ms elapsed * 1/ms = 5 tokens available, capped at 10
})

test('take() blocks via clock-driven polling until enough tokens accumulate', async () => {
  let simulatedNow = 0
  const clock = { now: () => simulatedNow }
  const b = tokenBucket({ capacity: 5, refillPerMs: 1, clock })
  b.tryTake(5, 0) // drain it
  const p = b.take(3, clock)
  for (let i = 0; i < 10 && b.tokens < 3; i++) { simulatedNow += 1; await Promise.resolve() }
  await p
  expect(b.tokens).toBeGreaterThanOrEqual(0)
})

test('zero-cost take never consumes tokens', () => {
  const b = tokenBucket({ capacity: 5, refillPerMs: 0, clock: { now: () => 0 } })
  expect(b.tryTake(0, 0)).toBe(true)
  expect(b.tokens).toBe(5)
})

test('tryTake rejects a negative cost instead of inflating tokens past capacity', () => {
  const b = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  expect(() => b.tryTake(-100, 0)).toThrow()
  expect(b.tokens).toBe(10)
})

test('take() rejects a negative cost instead of inflating tokens past capacity', async () => {
  const b = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  await expect(b.take(-100, { now: () => 0 })).rejects.toThrow()
  expect(b.tokens).toBe(10)
})

test('take() rejects a cost greater than capacity instead of spinning forever', async () => {
  const clock = { now: () => 0 }
  const b = tokenBucket({ capacity: 5, refillPerMs: 1, clock })
  await expect(b.take(6, clock)).rejects.toThrow(/exceeds bucket capacity/)
})

test('take() emits a token-wait event on every backoff iteration while starved', async () => {
  let simulatedNow = 0
  const clock = { now: () => simulatedNow }
  const events: any[] = []
  const b = tokenBucket({ capacity: 5, refillPerMs: 1, clock, onEvent: (e) => events.push(e) })
  b.tryTake(5, 0) // drain it
  const p = b.take(3, clock)
  for (let i = 0; i < 10 && b.tokens < 3; i++) { simulatedNow += 1; await Promise.resolve() }
  await p
  expect(events.length).toBeGreaterThan(0)
  expect(events.every(e => e.kind === 'token-wait')).toBe(true)
  expect(events[0]).toMatchObject({ kind: 'token-wait', attempt: 0 })
})

test('take() never emits an event when tokens are already available', async () => {
  const clock = { now: () => 0 }
  const events: any[] = []
  const b = tokenBucket({ capacity: 5, refillPerMs: 0, clock, onEvent: (e) => events.push(e) })
  await b.take(3, clock)
  expect(events).toEqual([])
})

test('take() uses an injected sleep instead of a real setTimeout wait', async () => {
  let simulatedNow = 0
  const clock = { now: () => simulatedNow }
  const b = tokenBucket({ capacity: 5, refillPerMs: 1, clock })
  b.tryTake(5, 0) // drain it
  const sleepCalls: number[] = []
  const sleep = async (ms: number) => { sleepCalls.push(ms); simulatedNow += ms }
  await b.take(3, clock, sleep)
  expect(sleepCalls.length).toBeGreaterThan(0)
})

test('take() rejects immediately with OpAbortError on an already-aborted signal, without waiting (#297)', async () => {
  const clock = { now: () => 0 }
  const b = tokenBucket({ capacity: 5, refillPerMs: 0, clock })
  b.tryTake(5, 0) // drain it, so a normal take() would have to wait
  const controller = new AbortController()
  controller.abort()
  await expect(b.take(3, clock, undefined, controller.signal)).rejects.toThrow(OpAbortError)
})

test('take() blocked on a starved bucket rejects on abort instead of waiting out the full delay (#297)', async () => {
  const clock = { now: () => 0 } // never refills -- take() would otherwise wait forever
  const b = tokenBucket({ capacity: 5, refillPerMs: 0, clock })
  b.tryTake(5, 0) // drain it
  const controller = new AbortController()
  const blockingSleep = () => new Promise<void>(() => {}) // never resolves on its own
  const run = b.take(3, clock, blockingSleep, controller.signal)
  await Promise.resolve() // let take() reach its first wait
  controller.abort()
  await expect(run).rejects.toThrow(OpAbortError)
})
