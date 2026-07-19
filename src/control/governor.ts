import type { LeafFn, LeafOpts, Caps, Governor } from '../op/types.js'
import type { Clock } from '../effects/types.js'
import type { GovernorEventHandler } from './events.js'
import type { TraceEventHandler } from './trace.js'
import { backoffFullJitter, idempotencyKey } from './retry.js'
import { memoKey } from './memo.js'
import { circuitBreaker } from './circuit-breaker.js'
import { tokenBucket } from './token-bucket.js'
import { fixed, aimd } from './aimd.js'

export class CircuitOpenError extends Error {
  constructor(readonly governedName: string) {
    super(`circuit open for "${governedName}"`)
    this.name = 'CircuitOpenError'
  }
}

// Cooperative cancellation signal for a whole runInline call (#279): a
// distinct error type (not a plain Error/DOMException) so callers -- and
// runInline's own 'catch' case -- can tell "the caller asked us to stop"
// apart from an ordinary leaf/sink failure. Thrown at each of runGoverned's
// retry-loop checkpoints and at every node runInline's traced() wrapper
// dispatches; deliberately never caught by an op-tree `catch` node's
// fallback, since an abort is a control signal from outside the tree, not an
// application error the tree itself is expected to recover from.
export class OpAbortError extends Error {
  constructor() {
    super('op run aborted')
    this.name = 'OpAbortError'
  }
}

export interface RunGovernedOpts {
  backoff?: { base: number; cap: number }
  rand?: () => number
  sleep?: (ms: number) => Promise<void>
  onEvent?: GovernorEventHandler
  // Per-node execution trace for the whole runInline call, not just this
  // leaf's own governed retry -- see src/control/trace.ts's header comment
  // for why this is a separate stream from onEvent above. runGoverned itself
  // never reads this field; runInline's `traced()` wrapper is what emits it.
  onTrace?: TraceEventHandler
  // Cooperative-cancellation signal (#279): checked at runGoverned's retry
  // loop and at runInline's per-node traced() wrapper. A leaf/sink write's
  // in-flight effect call itself is never preempted -- this only stops the
  // op tree from *starting* further work (another retry attempt, the next
  // pipe step, the next map item) once the caller has asked to stop.
  signal?: AbortSignal
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Races a backoff sleep against the abort signal so a caller that cancels
// mid-backoff doesn't have to wait out the full delay (up to `backoff.cap`,
// 10s by default) before the abort takes effect.
function sleepOrAbort(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.reject(new OpAbortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new OpAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    sleep(ms).then(
      () => { signal.removeEventListener('abort', onAbort); resolve() },
      err => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

export type ConcurrencySpec = { kind: 'fixed'; n: number } | { kind: 'aimd'; start?: number; min?: number; max?: number }

export interface GovernorSpec {
  circuitBreaker?: { failureThreshold: number; cooldownMs: number; halfOpenSuccesses: number }
  tokenBucket?: { capacity: number; refillPerMs: number; clock: Clock }
  concurrency?: ConcurrencySpec
  heavyConcurrency?: ConcurrencySpec
}

/**
 * Builds a leaf's circuitBreaker/tokenBucket/concurrency together, wiring each
 * primitive's `onEvent` to the same `onEvent` sink and tagging every event
 * with `name` -- so passing one handler here (and as runInline's
 * `gOpts.onEvent`, for `retry-attempt`) yields a single, leaf-labeled
 * observability stream instead of remembering to wire a matching callback
 * into each primitive individually.
 */
export function createGovernor(name: string, spec: GovernorSpec, onEvent?: GovernorEventHandler): Governor {
  const tagged: GovernorEventHandler | undefined = onEvent && (e => onEvent({ ...e, name }))
  const buildConcurrency = (c: ConcurrencySpec) =>
    c.kind === 'fixed' ? fixed(c.n) : aimd({ start: c.start, min: c.min, max: c.max, onEvent: tagged })
  const governor: Governor = {}
  if (spec.circuitBreaker) governor.circuitBreaker = circuitBreaker({ ...spec.circuitBreaker, onEvent: tagged })
  if (spec.tokenBucket) governor.tokenBucket = tokenBucket({ ...spec.tokenBucket, onEvent: tagged })
  if (spec.concurrency) governor.concurrency = buildConcurrency(spec.concurrency)
  if (spec.heavyConcurrency) governor.heavyConcurrency = buildConcurrency(spec.heavyConcurrency)
  return governor
}

/**
 * Wraps a leaf's fn with the retry/rate-limit/circuit-breaker/concurrency gating
 * described in the Slice 3 design doc's §3.3 call-site pattern (breaker gate ->
 * token gate -> concurrency gate -> effect), driven off caps.clock so it stays
 * replay-deterministic. `retries` applies to any leaf kind (it's the leaf's own
 * declared resilience contract); the tokenBucket/circuitBreaker/concurrency gates
 * only apply to 'effect' leaves, since 'pure' leaves have no external dependency
 * to protect. Each retry attempt re-acquires/releases the concurrency slot (like
 * the token bucket, taken fresh per attempt) rather than holding it across
 * backoff sleeps, so a slow/failing leaf doesn't pin a slot idle while it waits.
 *
 * Exported standalone rather than inlined into runInline's switch so a future
 * sux-side runDurable can wrap its own leaf dispatch with the same gating and
 * backoff policy, substituting a durable `sleep` (e.g. a Workflows step-sleep)
 * for retries in place of the real setTimeout used here.
 *
 * `opts.memo` (opt-in per leaf, independent of `kind`/`heavy`) short-circuits
 * all of the above -- breaker/tokenBucket/concurrency/retries -- on a cache
 * hit, since there's nothing left to gate once the output is already known.
 * Requires `caps.cache`; with none supplied, memoization is silently a no-op
 * (same graceful-degradation pattern as `caps.ask` being optional) rather
 * than an error, so a leaf declaring `memo: true` still runs fine against a
 * Caps that hasn't wired a Cache yet.
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
  if (opts.memo && caps.cache) {
    const key = await memoKey(name, input)
    const cached = await caps.cache.get(key)
    if (cached !== undefined) { gOpts.onEvent?.({ kind: 'memo-hit', name }); return cached }
    const result = await runGoverned(name, { ...opts, memo: false }, fn, input, caps, governor, gOpts)
    await caps.cache.put(key, result)
    gOpts.onEvent?.({ kind: 'memo-miss', name })
    return result
  }
  const maxRetries = opts.retries ?? 0
  const backoff = gOpts.backoff ?? { base: 200, cap: 10_000 }
  const sleep = gOpts.sleep ?? defaultSleep
  const gated = opts.kind === 'effect'
  const breaker = gated ? governor?.circuitBreaker : undefined
  // A heavy leaf (LLM/PDF-bound) prefers its own, typically-lower ceiling
  // (governor.heavyConcurrency) over the general one, so heavy work doesn't
  // get scheduled as aggressively as lightweight effects; falls back to the
  // shared governor.concurrency when no heavy-specific limiter is configured.
  const concurrency = gated ? (opts.heavy ? governor?.heavyConcurrency ?? governor?.concurrency : governor?.concurrency) : undefined
  // Computed once, outside the retry loop, so every retry attempt hands the fn
  // the same key -- letting a capability that dedupes on it (e.g. an idempotent
  // HTTP POST) collapse retried attempts into a single side effect. Skipped
  // entirely when there's nothing to dedupe (maxRetries === 0): the digest is
  // a real crypto.subtle.digest call, not free, and a leaf/sink with no
  // retries has no repeated attempt for a capability to collapse.
  const idemKey = gated && maxRetries > 0 ? await idempotencyKey(name, input) : undefined

  for (let attempt = 0; ; attempt++) {
    if (gOpts.signal?.aborted) throw new OpAbortError()
    let probeReserved = false
    if (breaker) {
      if (!breaker.allow(caps.clock.now())) throw new CircuitOpenError(name)
      if (breaker.state === 'half-open') {
        if (!breaker.reserveHalfOpenProbe()) throw new CircuitOpenError(name)
        probeReserved = true
      }
    }
    let acquired = false
    let result: Awaited<ReturnType<typeof fn>>
    try {
      if (gated && governor?.tokenBucket) await governor.tokenBucket.take(1, caps.clock, sleep)
      if (concurrency) { await concurrency.acquire(); acquired = true }
      result = await fn(input, caps, idemKey)
    } catch (err) {
      if (acquired) concurrency!.release(false)
      if (probeReserved) breaker!.releaseHalfOpenProbe()
      breaker?.onFailure(caps.clock.now())
      if (attempt >= maxRetries) throw err
      const delayMs = backoffFullJitter(attempt, backoff, gOpts.rand)
      gOpts.onEvent?.({ kind: 'retry-attempt', name, attempt, delayMs })
      await sleepOrAbort(sleep, delayMs, gOpts.signal)
      continue
    }
    // Post-success bookkeeping deliberately sits outside the try/catch above:
    // a throw here (e.g. a host `onEvent` callback from breaker.onSuccess,
    // called after it's already flipped state to 'closed') must not be
    // misclassified as a leaf failure, which would double-release the
    // concurrency slot and reopen a breaker that just legitimately closed
    // (#275).
    if (acquired) concurrency!.release(true)
    if (probeReserved) breaker!.releaseHalfOpenProbe()
    breaker?.onSuccess(caps.clock.now())
    return result
  }
}
