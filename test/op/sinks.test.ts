import { test, expect } from 'vitest'
import { SINK_REGISTRY, STORE_SINK } from '../../src/op/sinks.js'
import { MemoryStore } from '../../src/effects/types.js'
import type { Caps } from '../../src/op/types.js'

const caps: Caps = { store: new MemoryStore(), llm: {} as any, clock: { now: () => 0 }, sinks: {} }

test('SINK_REGISTRY exposes the built-in `store` target', () => {
  expect(SINK_REGISTRY.store).toBe(STORE_SINK)
})

test('SINK_REGISTRY resolves inherited Object.prototype member names to undefined, not a function', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    expect(SINK_REGISTRY[name]).toBeUndefined()
  }
})

test('STORE_SINK.write re-puts the piped value as JSON and returns its Handle', async () => {
  const result = await STORE_SINK.write({ a: 1 }, caps)
  const bytes = await caps.store.get(result)
  expect(new TextDecoder().decode(bytes)).toBe('{"a":1}')
})
