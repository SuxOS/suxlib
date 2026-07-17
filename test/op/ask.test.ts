import { test, expect } from 'vitest'
import { ask } from '../../src/op/combinators.js'
test('ask builds an inspectable tree', () => {
  const a = ask('proceed?', { timeout: '30s', onTimeout: 'fail' })
  expect(a).toEqual({ tag: 'ask', prompt: 'proceed?', timeout: '30s', onTimeout: 'fail' })
})
