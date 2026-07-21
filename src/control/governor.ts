import type { LeafFn, LeafOpts, Caps, Governor } from '../op/types.js'
import type { Cache, Clock } from '../effects/types.js'
import type { GovernorEventHandler } from './events.js'
import type { TraceEventHandler } from './trace.js'
import { backoffFullJitter, idempotencyKey } from './retry.js'
import { memoKey, memoKeyMaterial } from './memo.js'
import { circuitBreaker } from './circuit-breaker.js'
import { tokenBucket } from './token-bucket.js'
import { fixed, aimd } from './aimd.js'
import { OpAbortError, sleepOrAbort } from './abort.js'

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
// application error the tree itself is expected to recover from. Defined in
// ./abort.js (see that file's header) and re-exported here so every existing
// `from '../control/governor.js'` import keeps working unchanged.
export { OpAbortError }

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

// Singleflight dedup for runGoverned's memo branch (#311): keyed per-Cache-
// instance (a WeakMap, not a module-level Map) so two unrelated Caps sharing
// this module don't coalesce calls against each other's cache. A concurrent
// second call for the same memoKeyMaterial (src/control/memo.ts) joins the
// first call's already-running promise instead of re-invoking `fn` --
// without this, two fan-out items (map/mapField's Promise.allSettled) with
// identical input both see a cache miss before either has finished and both
// run the leaf. The entry is deleted once the first call settles (success or
// failure), so a later, non-overlapping call still misses normally and
// re-checks the cache itself.
//
// Keyed by the synchronous memoKeyMaterial string, not the async (hashed)
// memoKey -- registering only after awaiting memoKey leaves a real window
// where a fast-settling call (e.g. a `pure` leaf with no retries) can
// register *and* already be cleaned up again before a second concurrent
// caller's own memoKey digest has even resolved, silently defeating the
// dedup. Every concurrently-launched call computes memoKeyMaterial
// synchronously and reaches this check before any of them can possibly have
// finished running the leaf, so there is no such window here.
const memoInFlight = new WeakMap<Cache, Map<string, Promise<any>>>()

function memoInFlightMap(cache: Cache): Map<string, Promise<any>> {
  let m = memoInFlight.get(cache)
  if (!m) { m = new Map(); memoInFlight.set(cache, m) }
  return m
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
 * Caps that hasn't wired a Cache yet. Two concurrent calls that hash to the
 * same memo key (e.g. duplicate items in one map/mapField fan-out) coalesce
 * onto a single in-flight run via `memoInFlightMap` above instead of each
 * independently executing `fn` (#311) -- the second caller emits its own
 * `memo-hit` and awaits the first caller's result/rejection rather than
 * re-running a possibly-`heavy`/`effect` leaf a second time.
 *
 * `runId` (#348) is the calling runInline call's own id (see inline.ts's
 * header comment on why it's minted once per top-level call and passed
 * unchanged through every recursive call) -- passed here as a plain
 * parameter, not folded into `gOpts`, since `gOpts` is a caller-supplied
 * object that may be reused across separate top-level runInline calls (the
 * exact multi-run-sharing scenario #348 exists to disambiguate), so mutating
 * it with a per-call runId would reintroduce the same cross-run ambiguity
 * one layer up. Every governor primitive's gating method
 * (allow/onSuccess/onFailure/take/release) takes it as an optional trailing
 * arg and stamps it onto the GovernorEvent it emits.
 *
 * `callId` (#380) is the same per-node id runInline's `traced()` mints for
 * this call's own TraceEvent -- distinct from `runId`, which two duplicate-
 * named leaves/sink-targets within one run (e.g. sink.fanout(['a', 'a']))
 * still share. Threaded alongside `runId` into every gating method the same
 * way, so a shared onEvent sink can attribute a GovernorEvent to the exact
 * call, not just the exact run.
 */
export async function runGoverned(
  name: string,
  opts: LeafOpts,
  fn: LeafFn,
  input: any,
  caps: Caps,
  governor: Governor | undefined,
  gOpts: RunGovernedOpts = {},
  runId?: string,
  callId?: string,
): Promise<any> {
  if (opts.memo && caps.cache) {
    const cache = caps.cache
    // Join an already-in-flight call for this exact key instead of racing it.
    // This check-and-register step runs with no `await` before it (the real,
    // hashed memoKey is only computed below, inside the async IIFE) so every
    // concurrently-launched call reaches it before any of them can possibly
    // have finished running the leaf -- see memoInFlight's own header comment
    // for why gating this on the async memoKey instead is unsafe.
    const inFlightKey = memoKeyMaterial(name, input)
    const inFlight = memoInFlightMap(cache)
    const existing = inFlight.get(inFlightKey)
    if (existing) { gOpts.onEvent?.({ kind: 'memo-hit', name, runId, callId }); return existing }
    const runPromise = (async () => {
      const key = await memoKey(name, input)
      const cached = await cache.get(key)
      if (cached !== undefined) { gOpts.onEvent?.({ kind: 'memo-hit', name, runId, callId }); return cached }
      const result = await runGoverned(name, { ...opts, memo: false }, fn, input, caps, governor, gOpts, runId, callId)
      await cache.put(key, result)
      gOpts.onEvent?.({ kind: 'memo-miss', name, runId, callId })
      return result
    })()
    inFlight.set(inFlightKey, runPromise)
    try {
      return await runPromise
    } finally {
      inFlight.delete(inFlightKey)
    }
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
      if (!breaker.allow(caps.clock.now(), runId, callId)) throw new CircuitOpenError(name)
      if (breaker.state === 'half-open') {
        if (!breaker.reserveHalfOpenProbe()) throw new CircuitOpenError(name)
        probeReserved = true
      }
    }
    let acquired = false
    let result: Awaited<ReturnType<typeof fn>>
    try {
      if (gated && governor?.tokenBucket) await governor.tokenBucket.take(1, caps.clock, sleep, gOpts.signal, runId, callId)
      if (concurrency) { await concurrency.acquire(gOpts.signal); acquired = true }
      result = await fn(input, caps, idemKey)
    } catch (err) {
      // A queued tokenBucket.take/concurrency.acquire aborting (#297), or an
      // abort-aware fn() throwing OpAbortError itself (#309), must not be
      // misclassified as a leaf failure (a real release(false) would charge
      // an aimd limiter's failure-halving for a leaf that never actually
      // ran to a real outcome) -- release the slot neutrally instead, same
      // principle as the post-success-bookkeeping guard below (#275).
      if (err instanceof OpAbortError) {
        if (acquired) {
          if (concurrency!.releaseNeutral) concurrency!.releaseNeutral(runId, callId)
          else concurrency!.release(true, runId, callId)
        }
        if (probeReserved) breaker!.releaseHalfOpenProbe()
        throw err
      }
      if (acquired) concurrency!.release(false, runId, callId)
      if (probeReserved) breaker!.releaseHalfOpenProbe()
      breaker?.onFailure(caps.clock.now(), runId, callId)
      if (attempt >= maxRetries) throw err
      const delayMs = backoffFullJitter(attempt, backoff, gOpts.rand)
      gOpts.onEvent?.({ kind: 'retry-attempt', name, attempt, delayMs, runId, callId })
      await sleepOrAbort(sleep, delayMs, gOpts.signal)
      continue
    }
    // Post-success bookkeeping deliberately sits outside the try/catch above:
    // a throw here (e.g. a host `onEvent` callback from breaker.onSuccess,
    // called after it's already flipped state to 'closed') must not be
    // misclassified as a leaf failure, which would double-release the
    // concurrency slot and reopen a breaker that just legitimately closed
    // (#275).
    if (acquired) concurrency!.release(true, runId, callId)
    if (probeReserved) breaker!.releaseHalfOpenProbe()
    breaker?.onSuccess(caps.clock.now(), runId, callId)
    return result
  }
}
