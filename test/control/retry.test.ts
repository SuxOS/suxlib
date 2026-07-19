import { test, expect } from 'vitest'
import { backoffFullJitter, idempotencyKey } from '../../src/control/retry.js'
test('full-jitter stays within [0, min(cap, base*2^n)] and idempotencyKey is stable', async () => {
  const d = backoffFullJitter(3, { base: 100, cap: 20_000 }, () => 0.5)
  expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(800) // base*2^3 = 800
  expect(await idempotencyKey('x', { a: 1 })).toBe(await idempotencyKey('x', { a: 1 }))
})
test('idempotencyKey does not collide on differing nested object fields', async () => {
  const k1 = await idempotencyKey('x', { a: { x: 1 }, b: 2 })
  const k2 = await idempotencyKey('x', { a: { y: 9 }, b: 2 })
  expect(k1).not.toBe(k2)
})
test('idempotencyKey does not collide on differing __proto__-named fields', async () => {
  const k1 = await idempotencyKey('x', JSON.parse('{"a":1,"__proto__":{"b":2}}'))
  const k2 = await idempotencyKey('x', JSON.parse('{"a":1,"__proto__":{"b":3}}'))
  expect(k1).not.toBe(k2)
})
test('idempotencyKey does not collide when name/args boundary shifts (no separator bug)', async () => {
  const k1 = await idempotencyKey('foo2', 3)
  const k2 = await idempotencyKey('foo', 23)
  expect(k1).not.toBe(k2)
})
