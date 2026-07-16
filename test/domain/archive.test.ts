import { test, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolveText } from '../../src/handles/handle.js'
import { unzip } from '../../src/domain/archive.js'
test('unzip expands a zip handle into per-file handles', async () => {
  const store = new MemoryStore()
  const zip = zipSync({ 'a.txt': strToU8('AAA'), 'b.txt': strToU8('BBB') })
  const zh = await putBytes(store, zip, 'application/zip')
  const parts = await unzip(zh, { store } as any)
  expect(parts.length).toBe(2)
  expect((await Promise.all(parts.map((p: any) => resolveText(store, p)))).sort()).toEqual(['AAA', 'BBB'])
})
