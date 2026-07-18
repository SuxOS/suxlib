import { test, expect } from 'vitest'
import { map, mapField, op } from '../../src/op/combinators.js'
import { fixed } from '../../src/control/aimd.js'
test('map wraps an inner op with a concurrency limiter', () => {
  const m = map(op('x', async (v) => v, { kind: 'pure' }), { concurrency: fixed(2) })
  expect(m.tag).toBe('map'); expect((m as any).op.name).toBe('x')
})

test('mapField wraps an inner op with a concurrency limiter, targeting one named field of each array element', () => {
  const m = mapField('entries', 'handle', op('x', async (v) => v, { kind: 'pure' }), { concurrency: fixed(2), renameTo: 'files' })
  expect(m.tag).toBe('mapField')
  expect((m as any).arrayField).toBe('entries')
  expect((m as any).elementField).toBe('handle')
  expect((m as any).renameTo).toBe('files')
  expect((m as any).op.name).toBe('x')
})
