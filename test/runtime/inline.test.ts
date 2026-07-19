import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { op, pipe, map, mapField, parallel, reconcile, sink, catchOp } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { runInline } from '../../src/runtime/inline.js'
import { createGovernor } from '../../src/control/governor.js'
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

test('runInline retries a flaky sink write per its own opts.retries (#247)', async () => {
  let calls = 0
  const caps: any = {
    store: new MemoryStore(), llm: {}, clock: { now: () => 0 },
    sinks: { out: { name: 'out', write: async (v: any) => { calls++; if (calls < 3) throw new Error('flaky'); return v } } },
  }
  const result = await runInline(sink('out', { retries: 3 }), 'value', caps, { sleep: async () => {}, rand: () => 0 })
  expect(result).toBe('value')
  expect(calls).toBe(3)
})

test('runInline lets one sink.fanout target override the fanout-level opts.retries (#251)', async () => {
  let logCalls = 0; let vaultCalls = 0
  const caps: any = {
    store: new MemoryStore(), llm: {}, clock: { now: () => 0 },
    sinks: {
      log: { name: 'log', write: async (v: any) => { logCalls++; if (logCalls < 3) throw new Error('flaky'); return v } },
      vault: { name: 'vault', write: async (v: any) => { vaultCalls++; throw new Error('flaky') } },
    },
  }
  const tree = sink.fanout([{ name: 'log' }, { name: 'vault', opts: { retries: 0 } }], { retries: 3 })
  await expect(runInline(tree, 'value', caps, { sleep: async () => {}, rand: () => 0 })).rejects.toThrow('flaky')
  expect(logCalls).toBe(3)
  expect(vaultCalls).toBe(1)
})

test('runInline gates a sink target through caps.governors keyed "sink:<name>", separate from a same-named leaf\'s own governor (#247)', async () => {
  const sinkGovernor = createGovernor('sink:out', { circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000, halfOpenSuccesses: 1 } })
  const leafGovernor = createGovernor('out', { circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000, halfOpenSuccesses: 1 } })
  const caps: any = {
    store: new MemoryStore(), llm: {}, clock: { now: () => 0 },
    sinks: { out: { name: 'out', write: async () => { throw new Error('boom') } } },
    governors: { 'sink:out': sinkGovernor, out: leafGovernor },
  }
  await expect(runInline(sink('out'), 'v', caps, { sleep: async () => {} })).rejects.toThrow('boom')
  await expect(runInline(sink('out'), 'v', caps, { sleep: async () => {} })).rejects.toThrow(/circuit open for "sink:out"/)
  expect(leafGovernor.circuitBreaker!.state).toBe('closed')
})

test('runInline runs mapField over one named field of each array element, passing the rest through and renaming the array field', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = mapField('entries', 'handle', op('double', async (n: number) => n * 2, { kind: 'pure' }), { concurrency: fixed(2), renameTo: 'files' })
  const result = await runInline(tree, { entries: [{ name: 'a', handle: 1 }, { name: 'b', handle: 2 }], skipped: ['x'] }, caps)
  expect(result).toEqual({ skipped: ['x'], files: [{ name: 'a', handle: 2 }, { name: 'b', handle: 4 }] })
})

test('runInline runs the catch branch against the original input when the try branch throws', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = catchOp(
    op('boom', async () => { throw new Error('primary failed') }, { kind: 'pure' }),
    op('fallback', async (n: number) => n * 10, { kind: 'pure' }),
  )
  const result = await runInline(tree, 5, caps)
  expect(result).toBe(50)
})

test('runInline skips the catch branch entirely when the try branch succeeds', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  let fallbackRan = false
  const tree = catchOp(
    op('ok', async (n: number) => n + 1, { kind: 'pure' }),
    op('fallback', async () => { fallbackRan = true; return -1 }, { kind: 'pure' }),
  )
  const result = await runInline(tree, 5, caps)
  expect(result).toBe(6)
  expect(fallbackRan).toBe(false)
})

test('runInline propagates the catch branch\'s own error when the fallback also fails', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = catchOp(
    op('boom', async () => { throw new Error('primary failed') }, { kind: 'pure' }),
    op('boom2', async () => { throw new Error('fallback failed too') }, { kind: 'pure' }),
  )
  await expect(runInline(tree, 5, caps)).rejects.toThrow('fallback failed too')
})

test('runInline runs a parallel node\'s branches over the same input, collecting results in declared order (#289)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = parallel(
    op('double', async (n: number) => n * 2, { kind: 'pure' }),
    op('square', async (n: number) => n * n, { kind: 'pure' }),
    op('negate', async (n: number) => -n, { kind: 'pure' }),
  )
  const result = await runInline(tree, 5, caps)
  expect(result).toEqual([10, 25, -5])
})

test('runInline feeds a parallel node\'s results straight into reconcile (#289)', async () => {
  const store = new MemoryStore()
  const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = pipe(
    parallel(
      op('a', async (w: string) => putText(store, `${w}-a`), { kind: 'effect' }),
      op('b', async (w: string) => putText(store, `${w}-b`), { kind: 'effect' }),
    ),
    reconcile({ mode: 'faithful-union' }),
  )
  const result = await runInline(tree, 'word', caps)
  const text = await resolveText(store, result)
  expect(text).toContain('word-a')
  expect(text).toContain('word-b')
})

test('runInline lets every parallel branch settle before rejecting on the first failure', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  let slowRan = false
  const tree = parallel(
    op('fast-fail', async () => { throw new Error('boom') }, { kind: 'pure' }),
    op('slow-ok', async (n: number) => { await new Promise((r) => setTimeout(r, 5)); slowRan = true; return n }, { kind: 'pure' }),
  )
  await expect(runInline(tree, 1, caps)).rejects.toThrow('boom')
  expect(slowRan).toBe(true)
})
