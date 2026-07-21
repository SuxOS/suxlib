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

test('runInline namespaces the checkpoint ledger by runSig (#398): the same runId with a different runSig misses instead of reading the other run\'s recorded value', async () => {
  const checkpoint = new MemoryCheckpoint()
  let calls = 0
  const leaf = op('id', async (n: number) => { calls++; return n + 1 }, { kind: 'pure' })
  const caps = baseCaps(checkpoint)
  const runId = 'shared-run-id'
  expect(await runInline(leaf, 1, caps, undefined, '', runId, 'victim-sig')).toBe(2)
  expect(calls).toBe(1)
  expect(await runInline(leaf, 1, caps, undefined, '', runId, 'attacker-sig')).toBe(2)
  expect(calls).toBe(2)
})

test('runInline: a matching runId and runSig still resumes -- checkpoint namespacing doesn\'t break legitimate resume (#398)', async () => {
  const checkpoint = new MemoryCheckpoint()
  let calls = 0
  const leaf = op('id', async (n: number) => { calls++; return n + 1 }, { kind: 'pure' })
  const caps = baseCaps(checkpoint)
  const runId = 'shared-run-id'
  expect(await runInline(leaf, 1, caps, undefined, '', runId, 'same-sig')).toBe(2)
  expect(await runInline(leaf, 1, caps, undefined, '', runId, 'same-sig')).toBe(2)
  expect(calls).toBe(1)
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

test('runInline writes an in-progress marker at node-enter, distinguishable from never-started, even before the node finishes (#425)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const leaf = op('id', async (n: number) => n + 1, { kind: 'pure' })
  const caps = baseCaps(checkpoint)
  const runId = 'run-1'
  expect(await checkpoint.get(runId, '')).toBeUndefined()
  await runInline(leaf, 1, caps, undefined, '', runId)
  expect(await checkpoint.get(runId, '')).toEqual({ done: true, value: 2 })
})

test('runInline re-runs a node whose checkpoint entry is only the in-progress marker (crashed before node-exit) instead of treating it as done (#425)', async () => {
  const checkpoint = new MemoryCheckpoint()
  let calls = 0
  const leaf = op('id', async (n: number) => { calls++; return n + 1 }, { kind: 'pure' })
  const caps = baseCaps(checkpoint)
  const runId = 'run-1'
  // Simulate a crash after node-enter recorded the marker but before node-exit
  // ever ran put().
  await checkpoint.start(runId, '')
  expect(await checkpoint.get(runId, '')).toEqual({ done: false })
  expect(await runInline(leaf, 1, caps, undefined, '', runId)).toBe(2)
  expect(calls).toBe(1)
  expect(await checkpoint.get(runId, '')).toEqual({ done: true, value: 2 })
})

test('runInline resumes a sink.fanout with duplicate target names, re-running only the copy that never finished (#423)', async () => {
  const checkpoint = new MemoryCheckpoint()
  let attempts = 0
  const caps: any = {
    store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, checkpoint,
    sinks: {
      a: {
        name: 'a',
        write: async (v: any) => {
          attempts++
          // Only the first of the two 'a' targets (by index) ever succeeds
          // on the first pass -- the second is left unfinished, simulating a
          // crash between the two concurrent writes completing.
          if (attempts === 2) throw new Error('crash before second a finishes')
          return v
        },
      },
    },
  }
  const tree = sink.fanout(['a', 'a'])
  const runId = 'resume-run'
  await expect(runInline(tree, 'payload', caps, undefined, '', runId)).rejects.toThrow('crash before second a finishes')
  expect(attempts).toBe(2)
  const result = await runInline(tree, 'payload', caps, undefined, '', runId)
  expect(result).toBe('payload')
  // Only the target that never checkpointed gets a fresh attempt -- if the
  // two 'a' targets shared one checkpoint key, the resume would either skip
  // both (attempts stays at 2) or redo both (attempts jumps to 4).
  expect(attempts).toBe(3)
})
