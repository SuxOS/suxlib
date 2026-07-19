import type { Concurrency } from '../op/types.js'
import type { GovernorEventHandler } from './events.js'
import { OpAbortError } from './abort.js'

// Queues `resolve` for a free slot, racing it against `signal` (#297) so a
// caller blocked behind a full limiter can be cancelled without waiting for
// a slot to actually open up. Once `pump()` has dequeued and resolved an
// entry, its abort listener is already removed -- matching the rest of the
// op engine's "checkpoint, not preemptive" convention (an already-acquired
// slot is never revoked out from under the caller).
function enqueue(q: Array<() => void>, pump: () => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new OpAbortError())
  if (!signal) return new Promise<void>(r => { q.push(r); pump() })
  return new Promise<void>((resolve, reject) => {
    const entry = () => { signal.removeEventListener('abort', onAbort); resolve() }
    const onAbort = () => {
      const i = q.indexOf(entry)
      if (i !== -1) q.splice(i, 1)
      reject(new OpAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    q.push(entry); pump()
  })
}

export function fixed(n: number): Concurrency {
  const limit = Math.max(1, n)
  let inflight = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < limit && q.length) { inflight++; q.shift()!() } }
  const releaseSlot = () => { inflight--; pump() }
  return {
    async acquire(signal?: AbortSignal) { await enqueue(q, pump, signal) },
    release() { releaseSlot() },
    releaseCancelled() { releaseSlot() },
  }
}

export interface Aimd extends Concurrency { readonly limit: number }
export function aimd(opts: { start?: number; min?: number; max?: number; onEvent?: GovernorEventHandler } = {}): Aimd {
  const min = Math.max(1, opts.min ?? 1), max = Math.max(min, opts.max ?? 64)
  let limit = Math.min(max, Math.max(min, opts.start ?? 4))
  let inflight = 0; let successes = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < limit && q.length) { inflight++; q.shift()!() } }
  return {
    get limit() { return limit },
    async acquire(signal?: AbortSignal) { await enqueue(q, pump, signal) },
    release(ok: boolean) {
      inflight--
      if (ok) {
        if (++successes >= limit) {
          limit = Math.min(max, limit + 1); successes = 0
          opts.onEvent?.({ kind: 'aimd-increase', limit })
        }
      } else {
        limit = Math.max(min, Math.floor(limit / 2)); successes = 0
        opts.onEvent?.({ kind: 'aimd-decrease', limit })
      }
      pump()
    },
    // Frees the slot without touching limit/successes or emitting an
    // aimd-increase/decrease event -- a cancelled item is neither a success
    // nor a failure of the leaf itself.
    releaseCancelled() { inflight--; pump() },
  }
}
