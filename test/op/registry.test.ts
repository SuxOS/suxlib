import { test, expect } from 'vitest'
import { LEAF_REGISTRY, resolveLeaf } from '../../src/op/registry.js'
import { pack, unpack, unzip } from '../../src/domain/archive.js'
import { shrink } from '../../src/domain/pdf.js'
import { redact, scrub } from '../../src/domain/sanitize.js'
import { convert } from '../../src/domain/transform.js'
import { extract, summarize } from '../../src/domain/text.js'
import { wrapHandle, unwrapHandle } from '../../src/op/reshape.js'

test('LEAF_REGISTRY contains every domain leaf under its wrapper name', () => {
  expect(LEAF_REGISTRY).toEqual({ pack, unpack, unzip, shrink, redact, scrub, convert, extract, summarize, wrapHandle, unwrapHandle })
})

test('resolveLeaf returns the exact registered fn for a known name', () => {
  expect(resolveLeaf('scrub')).toBe(scrub)
})

test('resolveLeaf throws a clear error for an unknown leaf name', () => {
  expect(() => resolveLeaf('does_not_exist')).toThrow(/unknown leaf "does_not_exist"/)
})

test('resolveLeaf rejects inherited Object.prototype member names instead of resolving them', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
    expect(() => resolveLeaf(name)).toThrow(new RegExp(`unknown leaf "${name}"`))
  }
})
