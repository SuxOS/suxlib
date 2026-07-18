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
  const min = opts.min ?? 1, max = opts.max ?? 64
  let limit = Math.min(max, Math.max(min, opts.start ?? 4))
  let inflight = 0; let successes = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < limit && q.length) { inflight++; q.shift()!() } }
  return {
    get limit() { return limit },
    async acquire() { await new Promise<void>(r => { q.push(r); pump() }) },
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
  }
}
