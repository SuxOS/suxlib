import { test, expect } from 'vitest'
import { map, op } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
test('map wraps an inner op with a concurrency limiter', () => {
  const m = map(op('x', async (v) => v, { kind: 'pure' }), { concurrency: fixed(2) })
  expect(m.tag).toBe('map'); expect((m as any).op.name).toBe('x')
})
