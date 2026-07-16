import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText, stamp } from '../../src/handles/handle.js'
test('putText/resolveText round-trip', async () => {
  const s = new MemoryStore(); const h = await putText(s, 'abc', 'text/markdown')
  expect(await resolveText(s, h)).toBe('abc'); expect(h.type).toBe('text/markdown')
})
test('stamp sets producedAt from the injected Clock without mutating the input', async () => {
  const s = new MemoryStore(); const h = await putText(s, 'x')
  const fakeClock = { now: () => 42 }
  const stamped = stamp(h, fakeClock)
  expect(stamped.producedAt).toBe(42)
  expect(h.producedAt).toBeUndefined()      // original handle untouched
  expect(stamped.r2Key).toBe(h.r2Key)        // same content identity, just annotated
})
