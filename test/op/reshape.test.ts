import { test, expect } from 'vitest'
import { wrapHandle, unwrapHandle } from '../../src/op/reshape.js'
import { MemoryStore } from '../../src/effects/types.js'
import type { Caps } from '../../src/op/types.js'

const caps: Caps = { store: new MemoryStore(), llm: {} as any, clock: { now: () => 0 }, sinks: {} }

test('wrapHandle wraps a bare Handle into {handle} for a leaf expecting that shape', async () => {
  const handle = await caps.store.put(new TextEncoder().encode('hello'), 'text/plain')
  await expect(wrapHandle(handle, caps)).resolves.toEqual({ handle })
})

test('unwrapHandle plucks the handle back out of a {handle, ...} leaf result', async () => {
  const handle = await caps.store.put(new TextEncoder().encode('hello'), 'text/plain')
  await expect(unwrapHandle({ handle, savedPct: 10 }, caps)).resolves.toBe(handle)
})

test('wrapHandle then unwrapHandle round-trips a bare Handle unchanged', async () => {
  const handle = await caps.store.put(new TextEncoder().encode('round trip'), 'text/plain')
  const wrapped = await wrapHandle(handle, caps)
  await expect(unwrapHandle(wrapped, caps)).resolves.toEqual(handle)
})

test('unwrapHandle throws on a bare Handle (e.g. chained straight after convert)', async () => {
  const handle = await caps.store.put(new TextEncoder().encode('bare'), 'text/plain')
  await expect(unwrapHandle(handle, caps)).rejects.toThrow(/not.*handle.*shaped/i)
})

test('unwrapHandle throws on undefined input', async () => {
  await expect(unwrapHandle(undefined, caps)).rejects.toThrow(/not.*handle.*shaped/i)
})
