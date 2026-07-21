import { test, expect } from 'vitest'
import { snapshotValue, MAX_SNAPSHOT_BYTES } from '../../src/control/trace.js'
import { MemoryStore } from '../../src/effects/types.js'

test('snapshotValue: stores a JSON snapshot of the value and returns a resolvable Handle', async () => {
  const store = new MemoryStore()
  const ref = await snapshotValue(store, { a: 1, b: [2, 3] })
  expect(ref).toBeDefined()
  const bytes = await store.get(ref!)
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ a: 1, b: [2, 3] })
})

test('snapshotValue: a null/undefined value snapshots as JSON null', async () => {
  const store = new MemoryStore()
  const ref = await snapshotValue(store, undefined)
  const bytes = await store.get(ref!)
  expect(new TextDecoder().decode(bytes)).toBe('null')
})

test('snapshotValue: a value that cannot be JSON-serialized (circular reference) returns undefined instead of throwing', async () => {
  const store = new MemoryStore()
  const circular: Record<string, unknown> = {}
  circular.self = circular
  await expect(snapshotValue(store, circular)).resolves.toBeUndefined()
})

test('snapshotValue: a value serializing over MAX_SNAPSHOT_BYTES is skipped as a bomb guard, not stored', async () => {
  const store = new MemoryStore()
  const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1)
  await expect(snapshotValue(store, huge)).resolves.toBeUndefined()
})
