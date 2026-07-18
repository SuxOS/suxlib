import { test, expect } from 'vitest'
import { wrapHandle, unwrapHandle, stampLeaf } from '../../src/op/reshape.js'
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

test('unwrapHandle throws on a non-{handle}-shaped input (e.g. a bare Handle straight from convert) instead of silently returning undefined', async () => {
  const handle = await caps.store.put(new TextEncoder().encode('hello'), 'text/plain')
  await expect(unwrapHandle(handle, caps)).rejects.toThrow(/no `handle` field/)
})

test('stampLeaf sets producedAt from caps.clock.now(), leaving the rest of the Handle unchanged', async () => {
  const handle = await caps.store.put(new TextEncoder().encode('hello'), 'text/plain')
  const clockCaps: Caps = { ...caps, clock: { now: () => 12345 } }
  await expect(stampLeaf(handle, clockCaps)).resolves.toEqual({ ...handle, producedAt: 12345 })
})
