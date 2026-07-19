import { test, expect } from 'vitest'
import { aimd, fixed } from '../../src/control/aimd.js'
test('aimd halves its limit on failure and grows on success', async () => {
  const c = aimd({ start: 8, min: 1 })
  await c.acquire(); c.release(false)          // failure → limit 8→4
  expect(c.limit).toBe(4)
  for (let i = 0; i < 4; i++) { await c.acquire(); c.release(true) } // successes → additive increase
  expect(c.limit).toBeGreaterThan(4)
})
test('aimd emits aimd-decrease and aimd-increase events on limit changes', async () => {
  const events: any[] = []
  const c = aimd({ start: 8, min: 1, onEvent: (e) => events.push(e) })
  await c.acquire(); c.release(false) // failure -> limit 8->4
  expect(events).toEqual([{ kind: 'aimd-decrease', limit: 4 }])
  for (let i = 0; i < 4; i++) { await c.acquire(); c.release(true) }
  expect(events.at(-1)).toMatchObject({ kind: 'aimd-increase' })
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
test('fixed(n) clamps n <= 0 to 1 instead of deadlocking forever', async () => {
  const c = fixed(0)
  await c.acquire()
  c.release(true)
  const c2 = fixed(-5)
  await c2.acquire()
  c2.release(true)
})
test('aimd clamps min <= 0 to 1 instead of decaying to 0 and deadlocking forever', async () => {
  const c = aimd({ start: 1, min: 0 })
  await c.acquire(); c.release(false) // failure -> limit would floor to 0 without the clamp
  expect(c.limit).toBe(1)
  await c.acquire() // must still be admitted, not queued forever
  c.release(true)
})
