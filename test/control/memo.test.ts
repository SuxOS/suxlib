import { test, expect } from 'vitest'
import { memoKey } from '../../src/control/memo.js'
import { idempotencyKey } from '../../src/control/retry.js'

test('memoKey is stable for identical name+input and differs on either changing', async () => {
  const k1 = await memoKey('shrink', { handle: { sha256: 'abc', r2Key: 'cas/abc', type: 'application/pdf', size: 3 } })
  const k2 = await memoKey('shrink', { handle: { sha256: 'abc', r2Key: 'cas/abc', type: 'application/pdf', size: 3 } })
  expect(k1).toBe(k2)
  expect(await memoKey('other', { handle: { sha256: 'abc' } })).not.toBe(await memoKey('shrink', { handle: { sha256: 'abc' } }))
  expect(await memoKey('shrink', { handle: { sha256: 'xyz' } })).not.toBe(await memoKey('shrink', { handle: { sha256: 'abc' } }))
})

test('memoKey ignores a Handle\'s producedAt so a reconcile winner memoizes on content, not on when it was produced', async () => {
  const base = { handle: { sha256: 'abc', r2Key: 'cas/abc', type: 'application/pdf', size: 3 } }
  const stamped1 = { handle: { ...base.handle, producedAt: 1000 } }
  const stamped2 = { handle: { ...base.handle, producedAt: 2000 } }
  expect(await memoKey('shrink', stamped1)).toBe(await memoKey('shrink', base))
  expect(await memoKey('shrink', stamped1)).toBe(await memoKey('shrink', stamped2))
})

test('memoKey does not collide with idempotencyKey for the same name+input', async () => {
  const name = 'shrink'; const input = { a: 1 }
  expect(await memoKey(name, input)).not.toBe(await idempotencyKey(name, input))
})

test('memoKey does not collide on differing Date fields', async () => {
  const k1 = await memoKey('x', { scheduledFor: new Date('2020-01-01') })
  const k2 = await memoKey('x', { scheduledFor: new Date('2030-06-15') })
  expect(k1).not.toBe(k2)
})
