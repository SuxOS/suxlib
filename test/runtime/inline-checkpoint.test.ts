import { test, expect } from 'vitest'
import { MemoryStore, MemoryCheckpoint } from '../../src/effects/types.js'
import { op, pipe, map, sink } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
import { runInline } from '../../src/runtime/inline.js'

function baseCaps(checkpoint: MemoryCheckpoint) {
  return { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {}, checkpoint } as any
}

test('runInline with no caps.checkpoint re-runs every node on every call (unchanged default behavior)', async () => {
  let calls = 0
  const leaf = op('id', async (n: number) => { calls++; return n + 1 }, { kind: 'pure' })
  const caps: any = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} }
  await runInline(leaf, 1, caps, undefined, '', 'run-1')
  await runInline(leaf, 1, caps, undefined, '', 'run-1')
  expect(calls).toBe(2)
})

test('runInline skips re-invoking a leaf already recorded for the same (runId, path)', async () => {
  const checkpoint = new MemoryCheckpoint()
  let calls = 0
  const leaf = op('id', async (n: number) => { calls++; return n + 1 }, { kind: 'pure' })
  const caps = baseCaps(checkpoint)
  const runId = 'run-1'
  expect(await runInline(leaf, 1, caps, undefined, '', runId)).toBe(2)
  expect(await runInline(leaf, 1, caps, undefined, '', runId)).toBe(2)
  expect(calls).toBe(1)
})

test('runInline does not share checkpoints across different runIds', async () => {
  const checkpoint = new MemoryCheckpoint()
  let calls = 0
  const leaf = op('id', async (n: number) => { calls++; return n + 1 }, { kind: 'pure' })
  const caps = baseCaps(checkpoint)
  expect(await runInline(leaf, 1, caps, undefined, '', 'run-1')).toBe(2)
  expect(await runInline(leaf, 1, caps, undefined, '', 'run-2')).toBe(2)
  expect(calls).toBe(2)
})

test('runInline checkpoints a whole finished pipe, so a resumed call skips every child step', async () => {
  const checkpoint = new MemoryCheckpoint()
  let firstCalls = 0; let secondCalls = 0
  const tree = pipe(
    op('double', async (n: number) => { firstCalls++; return n * 2 }, { kind: 'pure' }),
    op('addOne', async (n: number) => { secondCalls++; return n + 1 }, { kind: 'pure' }),
  )
  const caps = baseCaps(checkpoint)
  const runId = 'run-1'
  expect(await runInline(tree, 5, caps, undefined, '', runId)).toBe(11)
  expect(await runInline(tree, 5, caps, undefined, '', runId)).toBe(11)
  expect(firstCalls).toBe(1)
  expect(secondCalls).toBe(1)
})

test('runInline resumes a partially-completed map fanout, re-running only the item that never finished (#390)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const calls: number[] = []
  let item2Attempts = 0
  const tree = map(op('maybeCrash', async (n: number) => {
    calls.push(n)
    if (n === 2) {
      item2Attempts++
      if (item2Attempts === 1) throw new Error('boom')
    }
    return n * 10
  }, { kind: 'pure' }), { concurrency: fixed(2) })
  const caps = baseCaps(checkpoint)
  const runId = 'resume-run'
  await expect(runInline(tree, [1, 2], caps, undefined, '', runId)).rejects.toThrow('boom')
  expect(calls).toEqual([1, 2])
  const result = await runInline(tree, [1, 2], caps, undefined, '', runId)
  expect(result).toEqual([10, 20])
  // item at index 0 (n=1) is never re-invoked the second time; only the
  // still-unfinished item at index 1 (n=2) gets a fresh attempt.
  expect(calls).toEqual([1, 2, 2])
})

test('runInline checkpoints a sink target independently of its siblings, so a resumed fanout only redoes the target that never finished', async () => {
  const checkpoint = new MemoryCheckpoint()
  const logCalls: any[] = []; let vaultAttempts = 0
  const caps: any = {
    store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, checkpoint,
    sinks: {
      log: { name: 'log', write: async (v: any) => { logCalls.push(v); return v } },
      vault: {
        name: 'vault',
        write: async (v: any) => {
          vaultAttempts++
          if (vaultAttempts === 1) throw new Error('vault down')
          return v
        },
      },
    },
  }
  const tree = sink.fanout(['log', 'vault'])
  const runId = 'resume-run'
  await expect(runInline(tree, 'payload', caps, undefined, '', runId)).rejects.toThrow('vault down')
  expect(logCalls).toEqual(['payload'])
  const result = await runInline(tree, 'payload', caps, undefined, '', runId)
  expect(result).toBe('payload')
  // log's write only ever ran once -- the resumed call skipped it via checkpoint.
  expect(logCalls).toEqual(['payload'])
  expect(vaultAttempts).toBe(2)
})
