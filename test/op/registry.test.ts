import { test, expect } from 'vitest'
import { LEAF_REGISTRY, resolveLeaf, mergeLeaves } from '../../src/op/registry.js'
import type { LeafFn } from '../../src/op/types.js'
import { pack, unpack, unzip } from '../../src/domain/archive.js'
import { shrink } from '../../src/domain/pdf.js'
import { redact, scrub } from '../../src/domain/sanitize.js'
import { convert } from '../../src/domain/transform.js'
import { extract, summarize } from '../../src/domain/text.js'
import { wrapHandle, unwrapHandle, stampLeaf } from '../../src/op/reshape.js'

test('LEAF_REGISTRY contains every domain leaf under its wrapper name', () => {
  expect(LEAF_REGISTRY).toEqual({ pack, unpack, unzip, shrink, redact, scrub, convert, extract, summarize, wrapHandle, unwrapHandle, stamp: stampLeaf })
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

test('mergeLeaves with no extras returns LEAF_REGISTRY itself, not a copy', () => {
  expect(mergeLeaves()).toBe(LEAF_REGISTRY)
})

test('mergeLeaves adds a host-registered leaf alongside the built-ins', () => {
  const custom: LeafFn = async (input) => input
  const table = mergeLeaves({ custom })
  expect(resolveLeaf('custom', table)).toBe(custom)
  expect(resolveLeaf('scrub', table)).toBe(scrub)
})

test('mergeLeaves lets a host-registered leaf shadow a built-in name', () => {
  const overriddenScrub: LeafFn = async (input) => input
  const table = mergeLeaves({ scrub: overriddenScrub })
  expect(resolveLeaf('scrub', table)).toBe(overriddenScrub)
  expect(resolveLeaf('scrub', table)).not.toBe(scrub)
})

test('mergeLeaves rejects inherited Object.prototype member names the same way the built-in registry does', () => {
  const table = mergeLeaves({ custom: (async (input) => input) as LeafFn })
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    expect(() => resolveLeaf(name, table)).toThrow(new RegExp(`unknown leaf "${name}"`))
  }
})
