import type { Concurrency } from '../op/types.js'
import type { GovernorEventHandler } from './events.js'
export function fixed(n: number): Concurrency {
  let inflight = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < n && q.length) { inflight++; q.shift()!() } }
  return {
    async acquire() { await new Promise<void>(r => { q.push(r); pump() }) },
    release() { inflight--; pump() },
  }
}

export interface Aimd extends Concurrency { readonly limit: number }
export function aimd(opts: { start?: number; min?: number; max?: number; onEvent?: GovernorEventHandler } = {}): Aimd {
  let limit = opts.start ?? 4; const min = opts.min ?? 1, max = opts.max ?? 64
  let inflight = 0; let successes = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < limit && q.length) { inflight++; q.shift()!() } }
  return {
    get limit() { return limit },
    async acquire() { await new Promise<void>(r => { q.push(r); pump() }) },
    release(ok: boolean) {
      inflight--
      if (ok) {
        if (++successes >= limit) {
          const next = Math.min(max, limit + 1)
          if (next !== limit) opts.onEvent?.({ type: 'aimd-increase', limit: next })
          limit = next
          successes = 0
        }
      } else {
        const next = Math.max(min, Math.floor(limit / 2))
        if (next !== limit) opts.onEvent?.({ type: 'aimd-decrease', limit: next })
        limit = next
        successes = 0
      }
      pump()
    },
  }
}
