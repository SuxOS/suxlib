import type { Concurrency } from '../op/types.js'
export function fixed(n: number): Concurrency {
  let inflight = 0; const q: Array<() => void> = []
  return {
    async acquire() { if (inflight < n) { inflight++; return } await new Promise<void>(r => q.push(r)); inflight++ },
    release() { inflight--; const next = q.shift(); if (next) next() },
  }
}

export interface Aimd extends Concurrency { readonly limit: number }
export function aimd(opts: { start?: number; min?: number; max?: number } = {}): Aimd {
  let limit = opts.start ?? 4; const min = opts.min ?? 1, max = opts.max ?? 64
  let inflight = 0; let successes = 0; const q: Array<() => void> = []
  const pump = () => { while (inflight < limit && q.length) { inflight++; q.shift()!() } }
  return {
    get limit() { return limit },
    async acquire() { await new Promise<void>(r => { q.push(r); pump() }) },
    release(ok: boolean) {
      inflight--
      if (ok) { if (++successes >= limit) { limit = Math.min(max, limit + 1); successes = 0 } }
      else { limit = Math.max(min, Math.floor(limit / 2)); successes = 0 }
      pump()
    },
  }
}
