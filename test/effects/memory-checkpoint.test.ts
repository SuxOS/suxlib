import { test, expect } from 'vitest'
import { MemoryCheckpoint } from '../../src/effects/types.js'
test('MemoryCheckpoint.get returns undefined for a (runId, path) with no recorded result', async () => {
  const c = new MemoryCheckpoint()
  expect(await c.get('run-1', '0')).toBeUndefined()
})
test('MemoryCheckpoint round-trips a put() through get(), including a legitimately undefined value', async () => {
  const c = new MemoryCheckpoint()
  await c.put('run-1', '0', 42)
  expect(await c.get('run-1', '0')).toEqual({ done: true, value: 42 })
  await c.put('run-1', '1', undefined)
  expect(await c.get('run-1', '1')).toEqual({ done: true, value: undefined })
})
test('MemoryCheckpoint keeps separate runs\' checkpoints independent even when they share a path', async () => {
  const c = new MemoryCheckpoint()
  await c.put('run-1', '0', 'a')
  await c.put('run-2', '0', 'b')
  expect(await c.get('run-1', '0')).toEqual({ done: true, value: 'a' })
  expect(await c.get('run-2', '0')).toEqual({ done: true, value: 'b' })
})
