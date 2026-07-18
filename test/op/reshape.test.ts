import { test, expect } from 'vitest'
import { wrapHandle, unwrapHandle } from '../../src/op/reshape.js'
import { buildOp } from '../../src/op/spec.js'
import { runInline } from '../../src/runtime/inline.js'
import { MemoryStore, type Llm } from '../../src/effects/types.js'
import type { Caps } from '../../src/op/types.js'

const llm: Llm = {
  markdownFromPdf: async () => { throw new Error('unused') },
  summarize: async () => { throw new Error('unused') },
}

function makeCaps(): Caps {
  return { store: new MemoryStore(), llm, clock: { now: () => 0 }, sinks: {} }
}

test('wrapHandle wraps a bare value under `handle`', async () => {
  const caps = makeCaps()
  await expect(wrapHandle('anything', caps)).resolves.toEqual({ handle: 'anything' })
})

test('unwrapHandle extracts the `handle` field, dropping any siblings', async () => {
  const caps = makeCaps()
  await expect(unwrapHandle({ handle: 'inner', extra: 'dropped' }, caps)).resolves.toBe('inner')
})

test('wrapHandle -> unwrapHandle round-trips through a pipe op', async () => {
  const caps = makeCaps()
  const tree = buildOp({
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'wrapHandle', opts: { kind: 'pure' } },
      { tag: 'leaf', name: 'unwrapHandle', opts: { kind: 'pure' } },
    ],
  })
  await expect(runInline(tree, 'value', caps)).resolves.toBe('value')
})

test('wrapHandle bridges unzip (Handle -> Handle[]) into shrink\'s `{ handle, ...opts }` input shape via map', async () => {
  const caps = makeCaps()
  const a = await caps.store.put(new TextEncoder().encode('%PDF-a'), 'application/pdf')
  const b = await caps.store.put(new TextEncoder().encode('%PDF-b'), 'application/pdf')
  const tree = buildOp({
    tag: 'map',
    op: { tag: 'leaf', name: 'wrapHandle', opts: { kind: 'pure' } },
    concurrency: 2,
  })
  const result = await runInline(tree, [a, b], caps) as Array<{ handle: unknown }>
  expect(result).toEqual([{ handle: a }, { handle: b }])
})
