import { test, expect } from 'vitest'
import { parallel, op } from '../../src/op/combinators.js'

test('parallel wraps N branches into one op node', () => {
  const p = parallel(op('a', async (v) => v, { kind: 'pure' }), op('b', async (v) => v, { kind: 'pure' }))
  expect(p.tag).toBe('parallel')
  expect((p as any).ops.map((o: any) => o.name)).toEqual(['a', 'b'])
})

test('parallel with no branches is still a valid op node (validation belongs to buildOp/collectSpecErrors)', () => {
  const p = parallel()
  expect(p).toEqual({ tag: 'parallel', ops: [] })
})
