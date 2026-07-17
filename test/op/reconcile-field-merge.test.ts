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

test('fieldMerge: rejects __proto__ key and does not pollute Object.prototype (CWE-1321)', async () => {
  const s = new MemoryStore()
  const attack = await putText(s, '{"__proto__": {"polluted": "yes"}, "name": "mallory"}', 'application/json')
  const merged = JSON.parse(await resolveText(s, await fieldMerge([attack], s)))
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
  expect(merged).toEqual({ name: 'mallory' })
})

test('fieldMerge: keep-first policy keeps a field named like an Object.prototype member', async () => {
  const s = new MemoryStore()
  const a = await putText(s, JSON.stringify({ toString: 'first', hasOwnProperty: 'x' }), 'application/json')
  const b = await putText(s, JSON.stringify({ toString: 'second', hasOwnProperty: 'y' }), 'application/json')
  const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s, { defaultPolicy: 'keep-first' })))
  expect(merged.toString).toBe('first')
  expect(merged.hasOwnProperty).toBe('x')
})

test('fieldMerge: rejects constructor/prototype keys across multiple handles', async () => {
  const s = new MemoryStore()
  const a = await putText(s, '{"constructor": {"prototype": {"polluted2": "yes"}}}', 'application/json')
  const b = await putText(s, '{"prototype": {"polluted3": "yes"}, "id": "safe"}', 'application/json')
  const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s)))
  expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
  expect(({} as Record<string, unknown>).polluted3).toBeUndefined()
  expect(merged).toEqual({ id: 'safe' })
})
