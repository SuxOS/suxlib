import { test, expect } from 'vitest'
import { VERSION, tokenBucket, circuitBreaker } from '../src/index.js'
test('package loads', () => { expect(VERSION).toBe('0.0.0') })
test('token-bucket and circuit-breaker are on the public surface', () => {
  expect(typeof tokenBucket).toBe('function')
  expect(typeof circuitBreaker).toBe('function')
})
