import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText } from '../../src/handles/handle.js'
import { stamp } from '../../src/handles/handle.js'
import { lastWriteWins } from '../../src/op/reconcile.js'

test('lastWriteWins picks the handle with the latest producedAt, regardless of array position', async () => {
  const s = new MemoryStore()
  const early = stamp(await putText(s, 'v1'), { now: () => 10 })
  const late = stamp(await putText(s, 'v2'), { now: () => 30 })
  const mid = stamp(await putText(s, 'v3'), { now: () => 20 })
  const winner = lastWriteWins([early, late, mid])   // `late` is neither first nor last in the array
  expect(winner.r2Key).toBe(late.r2Key)
})

test('lastWriteWins breaks ties by later array position, deterministically', async () => {
  const s = new MemoryStore()
  const a = stamp(await putText(s, 'a'), { now: () => 10 })
  const b = stamp(await putText(s, 'b'), { now: () => 10 })   // same timestamp as a
  expect(lastWriteWins([a, b]).r2Key).toBe(b.r2Key)
  expect(lastWriteWins([b, a]).r2Key).toBe(a.r2Key)            // order-dependent, and that's documented
})

test('lastWriteWins throws if any handle is unstamped', async () => {
  const s = new MemoryStore()
  const stamped = stamp(await putText(s, 'a'), { now: () => 10 })
  const unstamped = await putText(s, 'b')
  expect(() => lastWriteWins([stamped, unstamped])).toThrow(/producedAt/)
})

test('lastWriteWins throws on empty input', () => {
  expect(() => lastWriteWins([])).toThrow(/empty/)
})
