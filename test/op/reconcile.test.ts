import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { faithfulUnion, fieldMerge } from '../../src/op/reconcile.js'
test('faithfulUnion concatenates and dedups identical blocks', async () => {
  const s = new MemoryStore()
  const a = await putText(s, 'shared\n', 'text/markdown')
  const b = await putText(s, 'shared\n', 'text/markdown') // identical → same handle
  const c = await putText(s, 'unique\n', 'text/markdown')
  const master = await resolveText(s, await faithfulUnion([a, b, c], s))
  expect(master.match(/shared/g)!.length).toBe(1)  // deduped
  expect(master).toContain('unique')
})
test('faithfulUnion throws on empty input, matching lastWriteWins/fieldMerge', async () => {
  const s = new MemoryStore()
  await expect(faithfulUnion([], s)).rejects.toThrow('faithfulUnion: empty input')
})
test('fieldMerge union policy dedupes primitive array elements', async () => {
  const s = new MemoryStore()
  const a = await putText(s, JSON.stringify({ tags: ['a', 'b'] }), 'application/json')
  const b = await putText(s, JSON.stringify({ tags: ['b', 'c'] }), 'application/json')
  const merged = await resolveText(s, await fieldMerge([a, b], s, { defaultPolicy: 'union' }))
  expect(JSON.parse(merged).tags).toEqual(['a', 'b', 'c'])
})
test('fieldMerge union policy dedupes structurally-identical object array elements', async () => {
  const s = new MemoryStore()
  const a = await putText(s, JSON.stringify({ tags: [{ id: 1 }] }), 'application/json')
  const b = await putText(s, JSON.stringify({ tags: [{ id: 1 }, { id: 2 }] }), 'application/json')
  const merged = await resolveText(s, await fieldMerge([a, b], s, { defaultPolicy: 'union' }))
  expect(JSON.parse(merged).tags).toEqual([{ id: 1 }, { id: 2 }])
})
