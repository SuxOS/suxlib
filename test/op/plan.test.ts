import { test, expect } from 'vitest'
import { planOpSpec } from '../../src/op/plan.js'
import type { OpSpec } from '../../src/op/spec.js'

test('planOpSpec counts nodes and sums Σ(retries+1) across every leaf, regardless of kind', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip', opts: { retries: 2 } },
      { tag: 'leaf', name: 'stamp', opts: { kind: 'pure', retries: 1 } },
    ],
  }
  const plan = planOpSpec(spec)
  expect(plan.nodeCount).toBe(3) // pipe + 2 leaves
  expect(plan.maxRetryMultiplier).toBe(3 + 2) // (2+1) + (1+1)
})

test('planOpSpec reports the widest map/mapField concurrency without guessing at array length', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 4 },
      { tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 9 },
    ],
  }
  const plan = planOpSpec(spec)
  expect(plan.maxConcurrency).toBe(9)
})

test('planOpSpec reports sink targets and sums each target\'s own effective retries', () => {
  const spec: OpSpec = {
    tag: 'sink',
    targets: ['store', { name: 'vault', opts: { retries: 3 } }],
    opts: { retries: 1 },
  }
  const plan = planOpSpec(spec)
  expect(plan.sinkTargets).toEqual(['store', 'vault'])
  // 'store' falls back to the sink-level opts.retries (1); 'vault' overrides to 3.
  expect(plan.maxRetryMultiplier).toBe((1 + 1) + (3 + 1))
})

test('planOpSpec falls back to the fanout\'s own opts per-field, not as a whole object, matching runInline\'s sink case', () => {
  // 'vault' only overrides `memo` -- its `retries` must still fall back to the
  // node-level opts.retries (2), not silently reset to 0.
  const spec: OpSpec = {
    tag: 'sink',
    targets: [{ name: 'vault', opts: { memo: true } }],
    opts: { retries: 2 },
  }
  const plan = planOpSpec(spec)
  expect(plan.maxRetryMultiplier).toBe(2 + 1)
  expect(plan.usesCache).toBe(true)
})

test('planOpSpec counts the synthetic mergeOp attempt for a leaf spec with params', () => {
  // buildOpNode (./spec.ts) inserts a `retries: 0` mergeOp ahead of the real
  // leaf whenever `params` is present -- that's one more governed attempt.
  const spec: OpSpec = { tag: 'leaf', name: 'convert', opts: { retries: 2 }, params: { to: 'yaml' } }
  const plan = planOpSpec(spec)
  expect(plan.maxRetryMultiplier).toBe(1 + (2 + 1)) // mergeOp attempt + (retries+1)
})

test('planOpSpec flags usesAsk for an ask node', () => {
  const spec: OpSpec = { tag: 'ask', prompt: 'proceed?', timeout: '5m', onTimeout: 'proceed' }
  const plan = planOpSpec(spec)
  expect(plan.usesAsk).toBe(true)
  expect(plan.nodeCount).toBe(1)
})

test('planOpSpec flags usesCache for any leaf/sink opting into memo', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'pageCount', opts: { memo: true } },
      { tag: 'sink', targets: ['store'], opts: { memo: true } },
    ],
  }
  const plan = planOpSpec(spec)
  expect(plan.usesCache).toBe(true)
})

test('planOpSpec flags usesLlm and lists llmLeaves for extract/summarize, not for other leaves', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'extract' },
      { tag: 'leaf', name: 'unzip' },
    ],
  }
  const plan = planOpSpec(spec)
  expect(plan.usesLlm).toBe(true)
  expect(plan.llmLeaves).toEqual(['extract'])
})

test('planOpSpec walks both branches of a catch node', () => {
  const spec: OpSpec = {
    tag: 'catch',
    try: { tag: 'sink', targets: ['store'] },
    catch: { tag: 'sink', targets: ['vault'] },
  }
  const plan = planOpSpec(spec)
  expect(plan.sinkTargets).toEqual(['store', 'vault'])
})

test('planOpSpec never builds an Op tree or otherwise executes anything -- a spec naming an unregistered leaf is fine', () => {
  const spec: OpSpec = { tag: 'leaf', name: 'not-a-real-leaf' }
  expect(() => planOpSpec(spec)).not.toThrow()
  expect(planOpSpec(spec).nodeCount).toBe(1)
})

test('planOpSpec silently skips a malformed node instead of throwing', () => {
  const spec = { tag: 'pipe' } as unknown as OpSpec // missing `steps`
  expect(() => planOpSpec(spec)).not.toThrow()
  expect(planOpSpec(spec).nodeCount).toBe(1)
})
