import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { op, pipe, map, mapField, reconcile, sink, catchOp, cond, parallel, race } from '../../src/op/combinators.js'
import { fixed, aimd } from '../../src/control/aimd.js'
import { putText, resolveText } from '../../src/handles/handle.js'
import { runInline } from '../../src/runtime/inline.js'
import { createGovernor, OpAbortError } from '../../src/control/governor.js'
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

test('runInline rejects a mapField renameTo that collides with a pre-existing sibling field instead of silently overwriting it (#331)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = mapField('entries', 'handle', op('id', async (h: number) => h, { kind: 'pure' }), { concurrency: fixed(2), renameTo: 'name' })
  await expect(runInline(tree, { entries: [{ handle: 1 }], name: 'important-data' }, caps)).rejects.toThrow(/renameTo "name" collides/)
})

test('runInline does not double-release a map item\'s concurrency slot when a post-success callback throws (#332)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const concurrency = fixed(2)
  let onEventCalls = 0
  const throwingConcurrency = {
    acquire: (signal?: AbortSignal) => concurrency.acquire(signal),
    release: (ok: boolean) => {
      concurrency.release(ok)
      if (ok) { onEventCalls++; throw new Error('onEvent boom') }
    },
  }
  const tree = map(op('id', async (n: number) => n, { kind: 'pure' }), { concurrency: throwingConcurrency as any })
  await expect(runInline(tree, [1], caps)).rejects.toThrow('onEvent boom')
  expect(onEventCalls).toBe(1)
})

test('map/mapField thread runId and callId into concurrency.release, so an aimd limiter\'s GovernorEvents carry them (#387)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const events: any[] = []
  const limiter = aimd({ start: 1, min: 1, onEvent: (e) => events.push(e) })
  const tree = map(op('id', async (n: number) => n, { kind: 'pure' }), { concurrency: limiter })
  const runId = 'fixed-run-id'
  await runInline(tree, [1, 2], caps, undefined, '', runId)
  expect(events.length).toBeGreaterThan(0)
  for (const e of events) {
    expect(e.runId).toBe(runId)
    expect(typeof e.callId).toBe('string')
  }
})

test('runInline aggregates every concurrent map item failure instead of surfacing only the first by index (#333)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = map(op('fail', async (n: number) => { throw new Error(`item ${n} failed`) }, { kind: 'pure' }), { concurrency: fixed(2) })
  try {
    await runInline(tree, [1, 2], caps)
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2)
    expect((err as AggregateError).errors.map((e: Error) => e.message).sort()).toEqual(['item 1 failed', 'item 2 failed'])
  }
})

test('runInline still throws the bare single error (not an AggregateError) when only one map item fails (#333)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = map(op('maybeFail', async (n: number) => { if (n === 2) throw new Error('boom'); return n }, { kind: 'pure' }), { concurrency: fixed(2) })
  await expect(runInline(tree, [1, 2], caps)).rejects.toThrow('boom')
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

test('runInline runs the first matching cond case\'s branch against the piped value (#196)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = cond([
    { when: { field: 'kind', equals: 'a' }, then: op('a', async (v: any) => `a:${v.n}`, { kind: 'pure' }) },
    { when: { field: 'kind', equals: 'b' }, then: op('b', async (v: any) => `b:${v.n}`, { kind: 'pure' }) },
  ])
  expect(await runInline(tree, { kind: 'b', n: 1 }, caps)).toBe('b:1')
})

test('runInline\'s cond falls back to `default` when no case matches, and throws with neither (#196)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const withDefault = cond(
    [{ when: { field: 'kind', equals: 'a' }, then: op('a', async () => 'a', { kind: 'pure' }) }],
    op('fallback', async () => 'fallback', { kind: 'pure' }),
  )
  expect(await runInline(withDefault, { kind: 'z' }, caps)).toBe('fallback')

  const withoutDefault = cond([{ when: { field: 'kind', equals: 'a' }, then: op('a', async () => 'a', { kind: 'pure' }) }])
  await expect(runInline(withoutDefault, { kind: 'z' }, caps)).rejects.toThrow(/no case matched/)
})

test('runInline\'s cond matches an `in` predicate, and compares the piped value itself when `field` is omitted (#196)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = cond([
    { when: { in: ['x', 'y'] }, then: op('matched', async (v: string) => `matched:${v}`, { kind: 'pure' }) },
  ], op('default', async () => 'default', { kind: 'pure' }))
  expect(await runInline(tree, 'y', caps)).toBe('matched:y')
  expect(await runInline(tree, 'z', caps)).toBe('default')
})

test('runInline runs every parallel branch concurrently over the same input, collecting results in `ops` order (#289)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = parallel([
    op('upper', async (v: string) => v.toUpperCase(), { kind: 'pure' }),
    op('lower', async (v: string) => v.toLowerCase(), { kind: 'pure' }),
    op('len', async (v: string) => v.length, { kind: 'pure' }),
  ])
  expect(await runInline(tree, 'Mixed', caps)).toEqual(['MIXED', 'mixed', 5])
})

test('runInline aggregates every concurrent parallel branch failure instead of surfacing only the first by index (#289)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = parallel([
    op('failA', async () => { throw new Error('branch a failed') }, { kind: 'pure' }),
    op('failB', async () => { throw new Error('branch b failed') }, { kind: 'pure' }),
  ])
  try {
    await runInline(tree, 'v', caps)
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2)
    expect((err as AggregateError).errors.map((e: Error) => e.message).sort()).toEqual(['branch a failed', 'branch b failed'])
  }
})

test('runInline still throws the bare single error (not an AggregateError) when only one parallel branch fails (#289)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = parallel([
    op('ok', async (v: string) => v, { kind: 'pure' }),
    op('fail', async () => { throw new Error('boom') }, { kind: 'pure' }),
  ])
  await expect(runInline(tree, 'v', caps)).rejects.toThrow('boom')
})

test('runInline feeds parallel\'s array-of-results straight into reconcile, composing "transform N ways then merge" as one pipeline (#289)', async () => {
  const store = new MemoryStore()
  const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = pipe(
    parallel([
      op('a', async () => putText(store, 'from-a'), { kind: 'effect' }),
      op('b', async () => putText(store, 'from-b'), { kind: 'effect' }),
    ]),
    reconcile({ mode: 'faithful-union' }),
  )
  const result = await runInline(tree, null, caps)
  const text = await resolveText(store, result)
  expect(text).toContain('from-a')
  expect(text).toContain('from-b')
})

test('runInline\'s race resolves the bare value of the first branch to succeed by default (need: 1) (#429, #431)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = race([
    op('slow', async () => { await new Promise((r) => setTimeout(r, 20)); return 'slow' }, { kind: 'pure' }),
    op('fast', async () => 'fast', { kind: 'pure' }),
  ])
  expect(await runInline(tree, 'v', caps)).toBe('fast')
})

test('runInline\'s race settles once `need` branches succeed, without waiting for a still-slower branch (#429)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  let slowRan = false
  const tree = race([
    op('a', async () => 'a', { kind: 'pure' }),
    op('b', async () => 'b', { kind: 'pure' }),
    op('slow', async () => { await new Promise((r) => setTimeout(r, 50)); slowRan = true; return 'slow' }, { kind: 'pure' }),
  ], { need: 2 })
  const result = await runInline(tree, 'v', caps)
  expect(result.sort()).toEqual(['a', 'b'])
  expect(slowRan).toBe(false)
})

test('runInline\'s race models a durability quorum: fan out to 3 sinks, settle once 2 have written (#429)', async () => {
  const store = new MemoryStore()
  const written: string[] = []
  const caps: any = {
    store, llm: {}, clock: { now: () => 0 },
    sinks: {
      a: { name: 'a', write: async (v: any) => { written.push('a'); return v } },
      b: { name: 'b', write: async (v: any) => { written.push('b'); return v } },
      c: { name: 'c', write: async (v: any) => { await new Promise((r) => setTimeout(r, 50)); written.push('c'); return v } },
    },
  }
  const tree = race([sink('a'), sink('b'), sink('c')], { need: 2 })
  const result = await runInline(tree, { doc: 1 }, caps)
  expect(result).toHaveLength(2)
  expect(written).toEqual(['a', 'b'])
})

test('runInline\'s race rejects once quorum becomes mathematically unreachable, without waiting for a still-pending branch (#429)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  let thirdRan = false
  const tree = race([
    op('failA', async () => { throw new Error('a failed') }, { kind: 'pure' }),
    op('failB', async () => { throw new Error('b failed') }, { kind: 'pure' }),
    op('slowC', async () => { await new Promise((r) => setTimeout(r, 50)); thirdRan = true; return 'c' }, { kind: 'pure' }),
  ], { need: 2 })
  try {
    await runInline(tree, 'v', caps)
    expect.unreachable()
  } catch (err) {
    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2)
  }
  expect(thirdRan).toBe(false)
})

test('runInline\'s race still throws the bare single error (not an AggregateError) when only one failure makes quorum unreachable (#429)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = race([
    op('fail', async () => { throw new Error('boom') }, { kind: 'pure' }),
    op('ok', async () => 'v', { kind: 'pure' }),
  ], { need: 2 })
  await expect(runInline(tree, 'v', caps)).rejects.toThrow('boom')
})

test('runInline\'s race stops a losing pipe branch from starting its next step once quorum is met (#429)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  let secondRan = false
  const tree = race([
    op('fast', async () => 'fast', { kind: 'pure' }),
    pipe(
      op('slowFirst', async () => { await new Promise((r) => setTimeout(r, 20)); return 'v' }, { kind: 'pure' }),
      op('second', async (v: string) => { secondRan = true; return v }, { kind: 'pure' }),
    ),
  ])
  const result = await runInline(tree, 'in', caps)
  expect(result).toBe('fast')
  // Gives the still-running losing branch's timer a chance to fire -- the
  // internal race signal aborted the moment 'fast' won, so its pipe's second
  // step must never start even once its first step finishes.
  await new Promise((r) => setTimeout(r, 40))
  expect(secondRan).toBe(false)
})

test('runInline\'s race throws instead of hanging forever when a hand-built node\'s `need` exceeds its `ops` length (#429)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = race([op('ok', async () => 'v', { kind: 'pure' })], { need: 2 })
  await expect(runInline(tree, 'v', caps)).rejects.toThrow(/`need`.*integer between/)
})

test('runInline\'s race throws instead of hanging forever when a hand-built node\'s `need` is below 1 and every branch fails (#444)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const tree = race([
    op('failA', async () => { throw new Error('a') }, { kind: 'pure' }),
    op('failB', async () => { throw new Error('b') }, { kind: 'pure' }),
  ], { need: 0 })
  await expect(runInline(tree, 'v', caps)).rejects.toThrow(/`need`.*integer between/)
})

test('runInline rejects with OpAbortError before running any node when gOpts.signal is already aborted (#279)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  let ran = false
  const controller = new AbortController(); controller.abort()
  const tree = op('never', async (n: number) => { ran = true; return n }, { kind: 'pure' })
  await expect(runInline(tree, 5, caps, { signal: controller.signal })).rejects.toThrow(OpAbortError)
  expect(ran).toBe(false)
})

test('runInline stops a pipe from starting its next step once aborted mid-run', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const controller = new AbortController()
  let secondRan = false
  const tree = pipe(
    op('first', async (n: number) => { controller.abort(); return n }, { kind: 'pure' }),
    op('second', async (n: number) => { secondRan = true; return n }, { kind: 'pure' }),
  )
  await expect(runInline(tree, 5, caps, { signal: controller.signal })).rejects.toThrow(OpAbortError)
  expect(secondRan).toBe(false)
})

test('runInline\'s catch does not run the fallback when the try branch fails due to abort (#279)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const controller = new AbortController(); controller.abort()
  let fallbackRan = false
  const tree = catchOp(
    op('boom', async (n: number) => n, { kind: 'pure' }),
    op('fallback', async () => { fallbackRan = true; return -1 }, { kind: 'pure' }),
  )
  await expect(runInline(tree, 5, caps, { signal: controller.signal })).rejects.toThrow(OpAbortError)
  expect(fallbackRan).toBe(false)
})

test('runInline cancels a map item still queued behind a full item-level concurrency limiter once aborted (#301)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const controller = new AbortController()
  let secondRan = false
  const tree = map(op('maybeAbort', async (n: number) => {
    if (n === 1) controller.abort()
    else secondRan = true
    return n
  }, { kind: 'pure' }), { concurrency: fixed(1) })
  await expect(runInline(tree, [1, 2], caps, { signal: controller.signal })).rejects.toThrow(OpAbortError)
  expect(secondRan).toBe(false)
})

test('runInline cancels a mapField item still queued behind a full item-level concurrency limiter once aborted (#301)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const controller = new AbortController()
  let secondRan = false
  const tree = mapField('entries', 'n', op('maybeAbort', async (n: number) => {
    if (n === 1) controller.abort()
    else secondRan = true
    return n
  }, { kind: 'pure' }), { concurrency: fixed(1) })
  await expect(runInline(tree, { entries: [{ n: 1 }, { n: 2 }] }, caps, { signal: controller.signal })).rejects.toThrow(OpAbortError)
  expect(secondRan).toBe(false)
})

test('runInline releases a map item\'s aimd concurrency slot neutrally (not as a failure) when the item throws OpAbortError, so the limiter\'s failure-halving is not charged for a cancellation (#399)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const limiter = aimd({ start: 4, min: 1, max: 8 })
  const tree = map(op('aborted', async () => { throw new OpAbortError() }, { kind: 'pure' }), { concurrency: limiter })
  await expect(runInline(tree, [1], caps)).rejects.toThrow(OpAbortError)
  // A real failure would halve the limit (4 -> 2, per aimd's release(false)); a
  // neutral release must leave it untouched.
  expect(limiter.limit).toBe(4)
})

test('runInline releases a mapField item\'s aimd concurrency slot neutrally when the item throws OpAbortError (#399)', async () => {
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  const limiter = aimd({ start: 4, min: 1, max: 8 })
  const tree = mapField('entries', 'n', op('aborted', async () => { throw new OpAbortError() }, { kind: 'pure' }), { concurrency: limiter })
  await expect(runInline(tree, { entries: [{ n: 1 }] }, caps)).rejects.toThrow(OpAbortError)
  expect(limiter.limit).toBe(4)
})
