import type { Clock } from '../effects/types.js'
import { backoffFullJitter } from './retry.js'

export interface TokenBucket {
  tryTake(cost: number, nowMs: number): boolean
  take(cost: number, clock: Clock): Promise<void>
  readonly tokens: number
}

export function tokenBucket(opts: { capacity: number; refillPerMs: number; clock: Clock }): TokenBucket {
  let tokens = opts.capacity
  let lastRefillMs = opts.clock.now()

  function refill(nowMs: number) {
    const elapsed = Math.max(0, nowMs - lastRefillMs)
    tokens = Math.min(opts.capacity, tokens + elapsed * opts.refillPerMs)
    lastRefillMs = nowMs
  }

  const bucket: TokenBucket = {
    get tokens() { return tokens },
    tryTake(cost, nowMs) {
      refill(nowMs)
      if (tokens < cost) return false
      tokens -= cost
      return true
    },
    async take(cost, clock) {
      let attempt = 0
      while (!bucket.tryTake(cost, clock.now())) {
        const delayMs = Math.max(1, backoffFullJitter(attempt++, { base: 5, cap: 200 }))
        await new Promise((r) => setTimeout(r, delayMs))
      }
    },
  }
  return bucket
}
