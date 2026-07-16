import { test, expect } from 'vitest'
import { createFakeClock } from './fake-clock.js'

test('fake clock advances deterministically and implements Clock', () => {
  const c = createFakeClock(100)
  expect(c.now()).toBe(100)
  c.advance(50)
  expect(c.now()).toBe(150)
  c.set(0)
  expect(c.now()).toBe(0)
})

test('defaults to starting at 0', () => {
  const c = createFakeClock()
  expect(c.now()).toBe(0)
})
