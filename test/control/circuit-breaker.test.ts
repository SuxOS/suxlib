import { test, expect } from 'vitest'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'

test('starts closed and allows calls', () => {
  const b = circuitBreaker({ failureThreshold: 3, cooldownMs: 100, halfOpenSuccesses: 2 })
  expect(b.state).toBe('closed')
  expect(b.allow(0)).toBe(true)
})

test('trips to open after failureThreshold consecutive failures', () => {
  const b = circuitBreaker({ failureThreshold: 3, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.onFailure(0)
  expect(b.state).toBe('closed')
  b.onFailure(0)
  expect(b.state).toBe('open')
  expect(b.allow(0)).toBe(false)
})

test('a success in closed state resets the failure count', () => {
  const b = circuitBreaker({ failureThreshold: 3, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.onFailure(0); b.onSuccess(0); b.onFailure(0); b.onFailure(0)
  expect(b.state).toBe('closed') // failure count was reset by the success, so 2 more failures don't trip it
})

test('open transitions to half-open only after cooldownMs elapses, and allow() reflects it', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0)
  expect(b.allow(50)).toBe(false)   // still within cooldown
  expect(b.allow(100)).toBe(true)   // cooldown elapsed -> half-open probe allowed
  expect(b.state).toBe('half-open')
})

test('half-open closes after halfOpenSuccesses consecutive successes', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.allow(100) // -> half-open
  b.onSuccess(100)
  expect(b.state).toBe('half-open')
  b.onSuccess(100)
  expect(b.state).toBe('closed')
})

test('any failure in half-open reopens the breaker and resets the cooldown', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.allow(100) // -> half-open
  b.onFailure(100)
  expect(b.state).toBe('open')
  expect(b.allow(150)).toBe(false)  // new cooldown window starts at 100, not 0
  expect(b.allow(200)).toBe(true)
})

test('reserveHalfOpenProbe caps reservations at one until released', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  expect(b.reserveHalfOpenProbe()).toBe(true)
  expect(b.reserveHalfOpenProbe()).toBe(false) // already held
  b.releaseHalfOpenProbe()
  expect(b.reserveHalfOpenProbe()).toBe(true) // free again after release
})

test('releaseHalfOpenProbe without a prior reservation is a harmless no-op', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.releaseHalfOpenProbe()
  expect(b.reserveHalfOpenProbe()).toBe(true)
})
