import { test, expect } from 'vitest'
import { op, pipe } from '../../src/op/combinators.js'
test('op + pipe build an inspectable tree', () => {
  const t = pipe(op('a', async (x) => x + 1, { kind: 'pure' }), op('b', async (x) => x * 2, { kind: 'pure' }))
  expect(t.tag).toBe('pipe'); expect((t as any).steps.map((s: any) => s.name)).toEqual(['a', 'b'])
})
