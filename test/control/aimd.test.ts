import { test, expect } from 'vitest'
import { aimd, fixed } from '../../src/control/aimd.js'
test('aimd halves its limit on failure and grows on success', async () => {
  const c = aimd({ start: 8, min: 1 })
  await c.acquire(); c.release(false)          // failure → limit 8→4
  expect(c.limit).toBe(4)
  for (let i = 0; i < 4; i++) { await c.acquire(); c.release(true) } // successes → additive increase
  expect(c.limit).toBeGreaterThan(4)
})
test('fixed(n) never admits more than n concurrently across acquire/release interleaving', async () => {
  const c = fixed(1)
  let inflight = 0; let maxInflight = 0
  const run = async () => {
    await c.acquire()
    inflight++; maxInflight = Math.max(maxInflight, inflight)
    await Promise.resolve()
    inflight--; c.release(true)
  }
  await Promise.all([run(), run(), run()])
  expect(maxInflight).toBe(1)
})
