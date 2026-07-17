import type { LeafFn, LeafOpts, Caps, Governor } from '../op/types.js'
import { backoffFullJitter, idempotencyKey } from './retry.js'

export class CircuitOpenError extends Error {
  constructor(readonly leafName: string) {
    super(`circuit open for leaf "${leafName}"`)
    this.name = 'CircuitOpenError'
  }
}

export interface RunGovernedOpts {
  backoff?: { base: number; cap: number }
  rand?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wraps a leaf's fn with the retry/rate-limit/circuit-breaker gating described in
 * the Slice 3 design doc's §3.3 call-site pattern (breaker gate -> token gate ->
 * effect), driven off caps.clock so it stays replay-deterministic. `retries`
 * applies to any leaf kind (it's the leaf's own declared resilience contract);
 * the tokenBucket/circuitBreaker gates only apply to 'effect' leaves, since
 * 'pure' leaves have no external dependency to protect.
 *
 * Exported standalone rather than inlined into runInline's switch so a future
 * sux-side runDurable can wrap its own leaf dispatch with the same gating and
 * backoff policy, substituting a durable `sleep` (e.g. a Workflows step-sleep)
 * for retries in place of the real setTimeout used here.
 */
export async function runGoverned(
  name: string,
  opts: LeafOpts,
  fn: LeafFn,
  input: any,
  caps: Caps,
  governor: Governor | undefined,
  gOpts: RunGovernedOpts = {},
): Promise<any> {
  const maxRetries = opts.retries ?? 0
  const backoff = gOpts.backoff ?? { base: 200, cap: 10_000 }
  const sleep = gOpts.sleep ?? defaultSleep
  const gated = opts.kind === 'effect'
  const breaker = gated ? governor?.circuitBreaker : undefined
  // Computed once, outside the retry loop, so every retry attempt hands the fn
  // the same key -- letting a capability that dedupes on it (e.g. an idempotent
  // HTTP POST) collapse retried attempts into a single side effect.
  const idemKey = gated ? await idempotencyKey(name, input) : undefined

  for (let attempt = 0; ; attempt++) {
    let probeReserved = false
    if (breaker) {
      if (!breaker.allow(caps.clock.now())) throw new CircuitOpenError(name)
      if (breaker.state === 'half-open') {
        if (!breaker.reserveHalfOpenProbe()) throw new CircuitOpenError(name)
        probeReserved = true
      }
    }
    if (gated && governor?.tokenBucket) await governor.tokenBucket.take(1, caps.clock)
    try {
      const result = await fn(input, caps, idemKey)
      breaker?.onSuccess(caps.clock.now())
      return result
    } catch (err) {
      breaker?.onFailure(caps.clock.now())
      if (attempt >= maxRetries) throw err
      await sleep(backoffFullJitter(attempt, backoff, gOpts.rand))
    } finally {
      if (probeReserved) breaker!.releaseHalfOpenProbe()
    }
  }
}
