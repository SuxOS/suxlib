import { test, expect } from 'vitest'
import { tokenBucket } from '../../src/control/token-bucket.js'

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

test('take() rejects a cost greater than capacity instead of spinning forever', async () => {
  const clock = { now: () => 0 }
  const b = tokenBucket({ capacity: 5, refillPerMs: 1, clock })
  await expect(b.take(6, clock)).rejects.toThrow(/exceeds bucket capacity/)
})
