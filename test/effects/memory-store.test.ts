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
