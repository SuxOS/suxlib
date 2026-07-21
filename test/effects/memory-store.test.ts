import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
test('MemoryStore round-trips bytes and dedups by content', async () => {
  const s = new MemoryStore()
  const h = await s.put(new TextEncoder().encode('hello'), 'text/plain')
  expect(h.size).toBe(5)
  expect(new TextDecoder().decode(await s.get(h))).toBe('hello')
  const h2 = await s.put(new TextEncoder().encode('hello'), 'text/plain')
  expect(h2.r2Key).toBe(h.r2Key) // content-addressed → same key
})
test('MemoryStore.get rejects a Handle whose declared sha256 does not match the stored bytes', async () => {
  const s = new MemoryStore()
  const h = await s.put(new TextEncoder().encode('hello'), 'text/plain')
  await expect(s.get({ ...h, sha256: 'deadbeef' })).rejects.toThrow(/sha256 mismatch/)
})
test('MemoryStore.get rejects a Handle whose declared size does not match the stored bytes', async () => {
  const s = new MemoryStore()
  const h = await s.put(new TextEncoder().encode('hello'), 'text/plain')
  await expect(s.get({ ...h, size: 999 })).rejects.toThrow(/size mismatch/)
})
