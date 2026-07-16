import type { Concurrency } from '../op/types.js'
export function fixed(n: number): Concurrency {
  let inflight = 0; const q: Array<() => void> = []
  return {
    async acquire() { if (inflight < n) { inflight++; return } await new Promise<void>(r => q.push(r)); inflight++ },
    release() { inflight--; const next = q.shift(); if (next) next() },
  }
}
