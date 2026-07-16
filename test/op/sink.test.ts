import { test, expect } from 'vitest'
import { sink } from '../../src/op/combinators.js'
test('sink and sink.fanout produce target lists', () => {
  expect(sink('r2')).toEqual({ tag: 'sink', targets: ['r2'] })
  expect((sink.fanout('r2', 'vault') as any).targets).toEqual(['r2', 'vault'])
})
