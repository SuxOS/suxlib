import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText, stamp } from '../../src/handles/handle.js'
import { op, pipe, map, reconcile } from '../../src/op/combinators.js'
import { runInline } from '../../src/runtime/inline.js'
import { stampLeaf } from '../../src/op/reshape.js'
import { fixed } from '../../src/control/aimd.js'

test('runInline dispatches last-write-wins end-to-end through a full op tree', async () => {
  const store = new MemoryStore()
  const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = pipe(
    op('stampAll', async (handles: any[]) => handles.map(h => stamp(h, { now: () => Math.random() + h.size })), { kind: 'pure' }),
    reconcile({ mode: 'last-write-wins' }),
  )
  const a = await putText(store, 'aa'); const b = await putText(store, 'bbbb')  // different sizes -> deterministic ordering via size-based fake clock
  const result = await runInline(tree, [a, b], caps)
  expect(result.r2Key).toBe(b.r2Key)   // larger size -> larger fake timestamp -> wins
})

test('runInline dispatches field-merge end-to-end through a full op tree', async () => {
  const store = new MemoryStore()
  const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const a = await putText(store, JSON.stringify({ x: 1 }), 'application/json')
  const b = await putText(store, JSON.stringify({ x: 2 }), 'application/json')
  const tree = reconcile({ mode: 'field-merge' })
  const result = await runInline(tree, [a, b], caps)
  expect(JSON.parse(await resolveText(store, result))).toEqual({ x: 2 })
})

test('runInline reaches last-write-wins through the registered stamp leaf (map(stamp) -> reconcile), not a hand-rolled one', async () => {
  const store = new MemoryStore()
  let t = 0
  const caps: any = { store, llm: {}, clock: { now: () => t++ }, sinks: {} }
  const tree = pipe(
    map(op('stamp', stampLeaf, { kind: 'pure' }), { concurrency: fixed(1) }),
    reconcile({ mode: 'last-write-wins' }),
  )
  const a = await putText(store, 'aa'); const b = await putText(store, 'bbbb')
  const result = await runInline(tree, [a, b], caps)
  expect(result.r2Key).toBe(b.r2Key)   // stamped after a -> later fake timestamp -> wins
})

test('runInline still dispatches faithful-union unchanged (regression)', async () => {
  const store = new MemoryStore()
  const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const a = await putText(store, 'hello\n', 'text/markdown')
  const tree = reconcile({ mode: 'faithful-union' })
  const result = await runInline(tree, [a], caps)
  expect(await resolveText(store, result)).toContain('hello')
})
