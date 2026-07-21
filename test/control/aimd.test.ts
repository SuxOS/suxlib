import { test, expect } from 'vitest'
import { aimd, fixed } from '../../src/control/aimd.js'
import { OpAbortError } from '../../src/control/abort.js'
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

test('aimd clamps max <= 0 to min instead of deadlocking forever', async () => {
  const c = aimd({ start: 4, min: 1, max: 0 })
  expect(c.limit).toBeGreaterThanOrEqual(1)
  await c.acquire() // must still be admitted, not queued forever
  c.release(true)
})

test('aimd clamps max to be at least min so a decrease can never exceed the declared ceiling', async () => {
  const c = aimd({ start: 4, min: 100, max: 64 })
  expect(c.limit).toBe(100) // start is bounded up to min, and max was raised to match
  await c.acquire(); c.release(false) // failure -> decrease path must not exceed max
  expect(c.limit).toBeLessThanOrEqual(100)
})

test('fixed(n).acquire rejects immediately with OpAbortError on an already-aborted signal (#297)', async () => {
  const c = fixed(1)
  const controller = new AbortController()
  controller.abort()
  await expect(c.acquire(controller.signal)).rejects.toThrow(OpAbortError)
})

test('fixed(n).acquire queued behind a full limiter rejects on abort instead of waiting for a free slot (#297)', async () => {
  const c = fixed(1)
  await c.acquire() // holds the only slot
  const controller = new AbortController()
  const queued = c.acquire(controller.signal)
  controller.abort()
  await expect(queued).rejects.toThrow(OpAbortError)
  // the aborted waiter must not have consumed the slot that later opens up
  c.release(true)
  await c.acquire()
})

test('aimd.acquire queued behind a full limiter rejects on abort instead of waiting for a free slot (#297)', async () => {
  const c = aimd({ start: 1, min: 1 })
  await c.acquire() // holds the only slot
  const controller = new AbortController()
  const queued = c.acquire(controller.signal)
  controller.abort()
  await expect(queued).rejects.toThrow(OpAbortError)
  c.release(true)
  await c.acquire()
})

test('aborting after a queued acquire has already been granted a slot has no effect (#297)', async () => {
  const c = fixed(1)
  const controller = new AbortController()
  await c.acquire(controller.signal) // slot free -> resolves synchronously-ish, listener already removed
  controller.abort() // must not retroactively fail the already-acquired slot
  c.release(true)
})
