import { test, expect } from 'vitest'
import { backoffFullJitter, idempotencyKey } from '../../src/control/retry.js'
test('full-jitter stays within [0, min(cap, base*2^n)] and idempotencyKey is stable', async () => {
  const d = backoffFullJitter(3, { base: 100, cap: 20_000 }, () => 0.5)
  expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(800) // base*2^3 = 800
  expect(await idempotencyKey('x', { a: 1 })).toBe(await idempotencyKey('x', { a: 1 }))
})
