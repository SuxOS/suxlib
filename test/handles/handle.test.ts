import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText } from '../../src/handles/handle.js'
test('putText/resolveText round-trip', async () => {
  const s = new MemoryStore(); const h = await putText(s, 'abc', 'text/markdown')
  expect(await resolveText(s, h)).toBe('abc'); expect(h.type).toBe('text/markdown')
})
