import type { Clock } from '../effects/types.js'
import type { GovernorEventHandler } from './events.js'
import { backoffFullJitter } from './retry.js'

export interface TokenBucket {
  tryTake(cost: number, nowMs: number): boolean
  take(cost: number, clock: Clock, sleep?: (ms: number) => Promise<void>): Promise<void>
  readonly tokens: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function tokenBucket(opts: { capacity: number; refillPerMs: number; clock: Clock; onEvent?: GovernorEventHandler }): TokenBucket {
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
    async take(cost, clock, sleep = defaultSleep) {
      if (cost > opts.capacity) {
        throw new Error(`tokenBucket.take: requested cost ${cost} exceeds bucket capacity ${opts.capacity} and can never be satisfied`)
      }
      let attempt = 0
      while (!bucket.tryTake(cost, clock.now())) {
        const delayMs = Math.max(1, backoffFullJitter(attempt, { base: 5, cap: 200 }))
        opts.onEvent?.({ kind: 'token-wait', attempt, delayMs })
        attempt++
        await sleep(delayMs)
      }
    },
  }
  return bucket
}
