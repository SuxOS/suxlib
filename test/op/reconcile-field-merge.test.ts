import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { fieldMerge } from '../../src/op/reconcile.js'

test('fieldMerge: default policy — later handle overwrites earlier handle field-by-field', async () => {
  const s = new MemoryStore()
  const a = await putText(s, JSON.stringify({ name: 'alice', age: 30 }), 'application/json')
  const b = await putText(s, JSON.stringify({ age: 31, city: 'nyc' }), 'application/json')
  const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s)))
  expect(merged).toEqual({ name: 'alice', age: 31, city: 'nyc' })
})

test('fieldMerge: union policy de-duplicates and concatenates array fields', async () => {
  const s = new MemoryStore()
  const a = await putText(s, JSON.stringify({ tags: ['x', 'y'] }), 'application/json')
  const b = await putText(s, JSON.stringify({ tags: ['y', 'z'] }), 'application/json')
  const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s, { policy: { tags: 'union' } })))
  expect(merged.tags.sort()).toEqual(['x', 'y', 'z'])
})

test('fieldMerge: keep-first policy preserves the earliest value despite later overwrites', async () => {
  const s = new MemoryStore()
  const a = await putText(s, JSON.stringify({ id: 'original' }), 'application/json')
  const b = await putText(s, JSON.stringify({ id: 'clobbered' }), 'application/json')
  const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s, { policy: { id: 'keep-first' } })))
  expect(merged.id).toBe('original')
})

test('fieldMerge throws on non-JSON handle content', async () => {
  const s = new MemoryStore()
  const bad = await putText(s, 'not json', 'application/json')
  await expect(fieldMerge([bad], s)).rejects.toThrow()
})

test('fieldMerge throws on empty input', async () => {
  const s = new MemoryStore()
  await expect(fieldMerge([], s)).rejects.toThrow(/empty/)
})
