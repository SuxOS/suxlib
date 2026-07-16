import { test, expect } from 'vitest'
import { createFlakyDependency } from './flaky-dependency.js'

test('flaky dependency is deterministic given the same seed', () => {
  const a = createFlakyDependency({ seed: 42, concurrencyRejectThreshold: 5, outageStartMs: 1000, outageEndMs: 1200, costTokensPerCall: 10 })
  const b = createFlakyDependency({ seed: 42, concurrencyRejectThreshold: 5, outageStartMs: 1000, outageEndMs: 1200, costTokensPerCall: 10 })
  const seq = (dep: typeof a) => Array.from({ length: 20 }, (_, i) => dep.call(2, i * 50).ok)
  expect(seq(a)).toEqual(seq(b))
})

test('rejects unconditionally during the outage window regardless of concurrency', () => {
  const dep = createFlakyDependency({ seed: 1, concurrencyRejectThreshold: 999, outageStartMs: 100, outageEndMs: 200, costTokensPerCall: 1 })
  expect(dep.call(0, 150).ok).toBe(false)
  expect(dep.call(0, 250).ok).toBe(true)
})

test('rejects above the concurrency threshold outside the outage window', () => {
  const dep = createFlakyDependency({ seed: 1, concurrencyRejectThreshold: 5, outageStartMs: 10_000, outageEndMs: 10_001, costTokensPerCall: 1 })
  expect(dep.call(6, 0).ok).toBe(false)
  expect(dep.call(5, 0).ok).toBe(true)
})

test('reports the configured cost on success', () => {
  const dep = createFlakyDependency({ seed: 1, concurrencyRejectThreshold: 5, outageStartMs: 10_000, outageEndMs: 10_001, costTokensPerCall: 7 })
  expect(dep.call(0, 0)).toEqual({ ok: true, costTokens: 7 })
})
