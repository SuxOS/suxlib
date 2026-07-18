import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { op, pipe, map, reconcile, sink } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { runInline } from '../../src/runtime/inline.js'
test('runInline threads a pipe: split → map → reconcile → sink', async () => {
  const store = new MemoryStore(); const written: any[] = []
  const caps: any = { store, llm: {}, clock: { now: () => 0 },
    sinks: { out: { name: 'out', write: async (v: any) => { written.push(v); return v } } } }
  const tree = pipe(
    op('split', async (words: string[]) => Promise.all(words.map(w => putText(store, w + '\n'))), { kind: 'effect' }),
    map(op('id', async (h) => h, { kind: 'pure' }), { concurrency: fixed(2) }),
    reconcile({ mode: 'faithful-union' }),
    sink('out'),
  )
  const result = await runInline(tree, ['alpha', 'beta'], caps)
  expect(written.length).toBe(1)
  expect(await resolveText(store, result)).toContain('alpha')
})

test('runInline throws a clear error for an unregistered sink target', async () => {
  const store = new MemoryStore()
  const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: { out: { name: 'out', write: async (v: any) => v } } }
  await expect(runInline(sink('missing'), 'value', caps)).rejects.toThrow(/unknown sink "missing".*out/)
})
