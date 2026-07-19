import { test, expect } from 'vitest'
import { op, parallel } from '../../src/op/combinators.js'
test('parallel builds a tree fanning one input into N op branches', () => {
  const a = op('a', async (v) => v, { kind: 'pure' })
  const b = op('b', async (v) => v, { kind: 'pure' })
  const t = parallel(a, b)
  expect(t.tag).toBe('parallel')
  expect((t as any).ops.map((o: any) => o.name)).toEqual(['a', 'b'])
})
