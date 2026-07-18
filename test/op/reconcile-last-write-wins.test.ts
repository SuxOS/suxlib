import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText } from '../../src/handles/handle.js'
import { stamp } from '../../src/handles/handle.js'
import { lastWriteWins } from '../../src/op/reconcile.js'
import { stampLeaf } from '../../src/op/reshape.js'
import { op, pipe, map, reconcile } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
import { runInline } from '../../src/runtime/inline.js'
import type { Caps } from '../../src/op/types.js'

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

test('map(stamp) -> reconcile(last-write-wins) resolves two unstamped branches end to end through the op engine', async () => {
  const store = new MemoryStore()
  const early = await putText(store, 'v1')
  const late = await putText(store, 'v2')
  let now = 0
  const caps: Caps = { store, llm: {} as any, clock: { now: () => now++ }, sinks: {} }

  const tree = pipe(
    map(op('stamp', stampLeaf, { kind: 'effect' }), { concurrency: fixed(1) }),
    reconcile({ mode: 'last-write-wins' }),
  )
  const winner = await runInline(tree, [early, late], caps)
  expect(winner.r2Key).toBe(late.r2Key)
})
