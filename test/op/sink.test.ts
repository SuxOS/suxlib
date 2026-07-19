import { test, expect } from 'vitest'
import { sink } from '../../src/op/combinators.js'
test('sink and sink.fanout produce target lists', () => {
  expect(sink('r2')).toEqual({ tag: 'sink', targets: ['r2'] })
  expect((sink.fanout(['r2', 'vault']) as any).targets).toEqual(['r2', 'vault'])
})

test('sink and sink.fanout carry an opts field only when supplied', () => {
  expect(sink('r2', { retries: 3 })).toEqual({ tag: 'sink', targets: ['r2'], opts: { retries: 3 } })
  expect(sink.fanout(['r2', 'vault'], { heavy: true })).toEqual({ tag: 'sink', targets: ['r2', 'vault'], opts: { heavy: true } })
})
