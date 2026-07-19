import { test, expect } from 'vitest'
import { matchPredicate } from '../../src/op/predicate.js'

test('matchPredicate: eq matches only an exact field value', () => {
  expect(matchPredicate({ kind: 'eq', field: 'type', value: 'a' }, { type: 'a' })).toBe(true)
  expect(matchPredicate({ kind: 'eq', field: 'type', value: 'a' }, { type: 'b' })).toBe(false)
  expect(matchPredicate({ kind: 'eq', field: 'type', value: 'a' }, {})).toBe(false)
})

test('matchPredicate: in matches any listed value', () => {
  expect(matchPredicate({ kind: 'in', field: 'type', values: ['a', 'b'] }, { type: 'b' })).toBe(true)
  expect(matchPredicate({ kind: 'in', field: 'type', values: ['a', 'b'] }, { type: 'c' })).toBe(false)
})

test('matchPredicate: exists matches a defined field, including falsy values', () => {
  expect(matchPredicate({ kind: 'exists', field: 'count' }, { count: 0 })).toBe(true)
  expect(matchPredicate({ kind: 'exists', field: 'count' }, { count: undefined })).toBe(false)
  expect(matchPredicate({ kind: 'exists', field: 'count' }, {})).toBe(false)
})

test('matchPredicate: never matches a non-object input', () => {
  expect(matchPredicate({ kind: 'exists', field: 'x' }, null)).toBe(false)
  expect(matchPredicate({ kind: 'exists', field: 'x' }, 5)).toBe(false)
  expect(matchPredicate({ kind: 'exists', field: 'x' }, 'str')).toBe(false)
})
