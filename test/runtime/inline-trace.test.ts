import { test, expect } from 'vitest'
import { op, pipe, map, mapField, sink, catchOp } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
import { runInline } from '../../src/runtime/inline.js'
import type { TraceEvent } from '../../src/control/trace.js'

function clockCaps(sinks: Record<string, any> = {}) {
  let now = 0
  return { store: {}, llm: {}, clock: { now: () => now++ }, sinks } as any
}

test('runInline emits no trace events when gOpts.onTrace is not supplied', async () => {
  const leaf = op('id', async (n: number) => n + 1, { kind: 'pure' })
  const result = await runInline(leaf, 1, clockCaps())
  expect(result).toBe(2)
})

test('runInline traces a single leaf: node-enter then node-exit with ok:true and a durationMs', async () => {
  const leaf = op('id', async (n: number) => n + 1, { kind: 'pure' })
  const trace: TraceEvent[] = []
  const result = await runInline(leaf, 1, clockCaps(), { onTrace: (e) => trace.push(e) })
  expect(result).toBe(2)
  expect(trace).toEqual([
    { kind: 'node-enter', tag: 'leaf', name: 'id', path: '' },
    { kind: 'node-exit', tag: 'leaf', name: 'id', path: '', durationMs: expect.any(Number), ok: true },
  ])
})

test('runInline traces a failing leaf: node-exit carries ok:false and the error message', async () => {
  const leaf = op('boom', async () => { throw new Error('kaboom') }, { kind: 'pure' })
  const trace: TraceEvent[] = []
  await expect(runInline(leaf, null, clockCaps(), { onTrace: (e) => trace.push(e) })).rejects.toThrow('kaboom')
  expect(trace).toEqual([
    { kind: 'node-enter', tag: 'leaf', name: 'boom', path: '' },
    { kind: 'node-exit', tag: 'leaf', name: 'boom', path: '', durationMs: expect.any(Number), ok: false, error: 'kaboom' },
  ])
})

test('runInline traces a pipe: container enter/exit plus each step addressed by its index path', async () => {
  const tree = pipe(
    op('a', async (n: number) => n + 1, { kind: 'pure' }),
    op('b', async (n: number) => n * 2, { kind: 'pure' }),
  )
  const trace: TraceEvent[] = []
  const result = await runInline(tree, 1, clockCaps(), { onTrace: (e) => trace.push(e) })
  expect(result).toBe(4)
  expect(trace.map(({ kind, tag, name, path }) => ({ kind, tag, name, path }))).toEqual([
    { kind: 'node-enter', tag: 'pipe', name: undefined, path: '' },
    { kind: 'node-enter', tag: 'leaf', name: 'a', path: '0' },
    { kind: 'node-exit', tag: 'leaf', name: 'a', path: '0' },
    { kind: 'node-enter', tag: 'leaf', name: 'b', path: '1' },
    { kind: 'node-exit', tag: 'leaf', name: 'b', path: '1' },
    { kind: 'node-exit', tag: 'pipe', name: undefined, path: '' },
  ])
  expect(trace.every((e) => e.kind !== 'node-exit' || e.ok)).toBe(true)
})

test('runInline traces a map: container enter/exit plus each item addressed by its index path', async () => {
  const tree = map(op('double', async (n: number) => n * 2, { kind: 'pure' }), { concurrency: fixed(2) })
  const trace: TraceEvent[] = []
  const result = await runInline(tree, [1, 2, 3], clockCaps(), { onTrace: (e) => trace.push(e) })
  expect(result).toEqual([2, 4, 6])
  const paths = trace.filter((e) => e.kind === 'node-enter').map((e) => e.path).sort()
  expect(paths).toEqual(['', '0', '1', '2'])
  expect(trace.length).toBe(8) // 1 map + 3 items, enter+exit each
})

test('runInline traces mapField: item paths address the array index, not the element field name', async () => {
  const tree = mapField('entries', 'handle', op('double', async (n: number) => n * 2, { kind: 'pure' }), { concurrency: fixed(2) })
  const trace: TraceEvent[] = []
  const result = await runInline(tree, { entries: [{ name: 'a', handle: 1 }, { name: 'b', handle: 2 }] }, clockCaps(), { onTrace: (e) => trace.push(e) })
  expect(result).toEqual({ entries: [{ name: 'a', handle: 2 }, { name: 'b', handle: 4 }] })
  const enters = trace.filter((e) => e.kind === 'node-enter')
  expect(enters.map((e) => e.path).sort()).toEqual(['', '0', '1'])
  expect(enters.find((e) => e.path === '0')).toMatchObject({ tag: 'leaf', name: 'double' })
})

test('runInline traces a catch node: the try branch\'s node-exit surfaces why the fallback fired', async () => {
  const tree = catchOp(
    op('boom', async () => { throw new Error('primary failed') }, { kind: 'pure' }),
    op('fallback', async (n: number) => n * 10, { kind: 'pure' }),
  )
  const trace: TraceEvent[] = []
  const result = await runInline(tree, 5, clockCaps(), { onTrace: (e) => trace.push(e) })
  expect(result).toBe(50)
  expect(trace.map(({ kind, tag, name, path, ...rest }) => ({ kind, tag, name, path, ok: (rest as any).ok, error: (rest as any).error })))
    .toEqual([
      { kind: 'node-enter', tag: 'catch', name: undefined, path: '', ok: undefined, error: undefined },
      { kind: 'node-enter', tag: 'leaf', name: 'boom', path: 'try', ok: undefined, error: undefined },
      { kind: 'node-exit', tag: 'leaf', name: 'boom', path: 'try', ok: false, error: 'primary failed' },
      { kind: 'node-enter', tag: 'leaf', name: 'fallback', path: 'catch', ok: undefined, error: undefined },
      { kind: 'node-exit', tag: 'leaf', name: 'fallback', path: 'catch', ok: true, error: undefined },
      { kind: 'node-exit', tag: 'catch', name: undefined, path: '', ok: true, error: undefined },
    ])
})

test('runInline traces a sink fanout: each target gets its own node-enter/exit, so a single failing target is identifiable', async () => {
  const tree = sink.fanout(['good', 'bad'])
  const caps = clockCaps({
    good: { name: 'good', write: async (v: any) => v },
    bad: { name: 'bad', write: async () => { throw new Error('write failed') } },
  })
  const trace: TraceEvent[] = []
  await expect(runInline(tree, { a: 1 }, caps, { onTrace: (e) => trace.push(e) })).rejects.toThrow('write failed')
  const exits = trace.filter((e) => e.kind === 'node-exit') as Extract<TraceEvent, { kind: 'node-exit' }>[]
  const goodExit = exits.find((e) => e.name === 'good')
  const badExit = exits.find((e) => e.name === 'bad')
  expect(goodExit).toMatchObject({ tag: 'sink-target', ok: true })
  expect(badExit).toMatchObject({ tag: 'sink-target', ok: false, error: 'write failed' })
  expect(exits.find((e) => e.tag === 'sink')).toMatchObject({ ok: false })
})

test('runInline\'s onTrace and gOpts.onEvent are independent streams: supplying one does not add events to the other', async () => {
  let calls = 0
  const leaf = op('flaky', async () => { calls++; if (calls < 2) throw new Error('flaky'); return 'ok' }, { kind: 'effect', retries: 2 })
  const events: any[] = []
  const trace: TraceEvent[] = []
  const result = await runInline(leaf, null, clockCaps(), { onEvent: (e) => events.push(e), onTrace: (e) => trace.push(e), sleep: async () => {} })
  expect(result).toBe('ok')
  expect(events).toEqual([{ kind: 'retry-attempt', name: 'flaky', attempt: 0, delayMs: expect.any(Number) }])
  expect(trace).toEqual([
    { kind: 'node-enter', tag: 'leaf', name: 'flaky', path: '' },
    { kind: 'node-exit', tag: 'leaf', name: 'flaky', path: '', durationMs: expect.any(Number), ok: true },
  ])
})
