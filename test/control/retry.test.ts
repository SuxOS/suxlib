import { test, expect } from 'vitest'
import { backoffFullJitter, idempotencyKey } from '../../src/control/retry.js'
test('full-jitter stays within [0, min(cap, base*2^n)] and idempotencyKey is stable', async () => {
  const d = backoffFullJitter(3, { base: 100, cap: 20_000 }, () => 0.5)
  expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(800) // base*2^3 = 800
  expect(await idempotencyKey('x', { a: 1 })).toBe(await idempotencyKey('x', { a: 1 }))
})

test('idempotencyKey distinguishes calls that only differ in a nested field', async () => {
  const a = await idempotencyKey('op', { user: { id: 1 } })
  const b = await idempotencyKey('op', { user: { id: 2 } })
  expect(a).not.toBe(b)
})

test('idempotencyKey is order-independent at every nesting level', async () => {
  const a = await idempotencyKey('op', { user: { id: 1, name: 'x' }, tag: 'z' })
  const b = await idempotencyKey('op', { tag: 'z', user: { name: 'x', id: 1 } })
  expect(a).toBe(b)
})

test('idempotencyKey handles null, primitive, and array args without throwing', async () => {
  await expect(idempotencyKey('op', null)).resolves.toBeTypeOf('string')
  await expect(idempotencyKey('op', 42)).resolves.toBeTypeOf('string')
  const a = await idempotencyKey('op', [1, { x: 1 }])
  const b = await idempotencyKey('op', [1, { x: 2 }])
  expect(a).not.toBe(b)
})
