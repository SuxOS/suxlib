import { test, expect } from 'vitest'
import * as lib from '../src/index.js'
test('slice-3 reconcile modes are on the public surface', () => {
  for (const name of ['stamp', 'lastWriteWins', 'fieldMerge', 'runReconcile']) {
    expect(typeof (lib as any)[name]).toBe('function')
  }
})
