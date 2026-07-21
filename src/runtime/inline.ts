import type { Op, Caps, Concurrency, CondPredicate } from '../op/types.js'
import { runReconcile } from '../op/reconcile.js'
import { runGoverned, OpAbortError, type RunGovernedOpts } from '../control/governor.js'
import { snapshotValue } from '../control/trace.js'

export class AskTimeoutError extends Error {
  constructor(readonly prompt: string) {
    super(`ask timed out with no answer: "${prompt}"`)
    this.name = 'AskTimeoutError'
  }
}

const childPath = (path: string, seg: string | number): string => (path === '' ? String(seg) : `${path}/${seg}`)

// Resolves a cond predicate's `field` off the piped value -- omitted (or, for an
// in-process Op tree built by hand rather than through OpSpec's validated field-name
// checks, a falsy field) compares the piped value itself, the only option for a
// primitive, non-object input.
function resolveCondField(input: any, field: string | undefined): unknown {
  if (!field) return input
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[field] : undefined
}

function evalCondPredicate(p: CondPredicate, input: any): boolean {
  const v = resolveCondField(input, p.field)
  return 'equals' in p ? v === p.equals : p.in.includes(v as any)
}

// Surfaces every concurrent failure from a fan-out (map/mapField/sink), not
// just the first-by-index one -- but preserves today's exact single-failure
// behavior (rethrow that one reason unwrapped) rather than always wrapping,
// since some callers (the 'catch' case's `err instanceof OpAbortError` check,
// #279) rely on the thrown value's own identity/type.
function throwFirstOrAggregate(results: PromiseSettledResult<any>[], label: string): void {
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason)
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, `${label}: ${failures.length} concurrent failures`)
}

// Mirrors runGoverned's own abort-branch release (src/control/governor.ts) --
// an item unwinding through OpAbortError was cancelled, not failed, so
// charging an aimd limiter's failure-halving for it (a plain release(false))
// would misclassify cooperative cancellation as a real failure (#399).
function releaseOnItemCatch(concurrency: Concurrency, e: unknown, runId: string, callId: string): void {
  if (e instanceof OpAbortError) {
    if (concurrency.releaseNeutral) concurrency.releaseNeutral(runId, callId)
    else concurrency.release(true, runId, callId)
    return
  }
  concurrency.release(false, runId, callId)
}

// Monotonic per-process counter backing traced()'s callId (#366) -- cheap
// (no crypto), and only needs to be unique among calls concurrently sharing
// one tag/name/path/runId, which a simple increment already guarantees.
let traceCallSeq = 0

// Wraps one Op node's execution with node-enter/node-exit trace events (see
// src/control/trace.ts) when gOpts.onTrace is supplied; a bare passthrough
// otherwise -- no timing call, no event object, no try/catch -- so tracing
// costs nothing when a caller doesn't ask for it.
//
// `fn` is handed the callId minted for this node (#380) so a 'leaf'/
// 'sink-target' call site can pass the identical id into runGoverned, which
// stamps it onto every GovernorEvent it causes a governor primitive to
// emit -- letting a shared onEvent sink (src/adapters/otel.ts) match a
// GovernorEvent to the exact call, not just the exact run, the same way
// TraceEvent's own callId (#366) already disambiguates two duplicate-named
// concurrent spans. When tracing is off (no onTrace), a callId is still
// minted so runGoverned always has one to stamp -- it just never appears in
// a TraceEvent.
//
// Checkpoint resume (#390): when caps.checkpoint is supplied, every node --
// not just 'leaf' -- consults it by (runId, path) before doing any work at
// all, and persists its result after. A `{ done: true }` hit short-circuits
// entirely (no callId minted, no trace event, no governor call, `fn` never
// invoked), so a runInline call sharing a prior run's runId skips
// re-executing any subtree already recorded -- a completed leaf, sink
// target, or a whole finished composite node. Since `path` already addresses
// individual map/mapField items and sink fanout targets, this gives
// partial-fanout resume for free: only the still-unfinished items of an
// in-flight fan-out actually re-run. With no caps.checkpoint (the common
// case), this is a pure no-op -- same degrade-gracefully contract as
// caps.ask/caps.cache.
//
// In-progress marker (#425): a `{ done: false }` hit (started but never
// finished, e.g. a prior crash) does NOT short-circuit -- `run()` calls
// `checkpoint.start(runId, path)` again right before invoking `fn`, and lets
// the node re-execute normally. `start()` is what lets a status query
// distinguish "never started" (checkpoint.get returns `undefined`) from
// "started, no result yet" (`{ done: false }`, covering both a still-running
// and a crashed run -- indistinguishable from ledger state alone) at any
// path a caller cares to check, not just the root.
//
// `runSig` (#398) namespaces that (runId, path) ledger by a hash of the run's
// spec/root input -- runId alone is a caller-supplied string a network caller
// can guess, observe, or simply reuse, and a bare (runId, path) key would then
// let a request with a mismatched spec read a stranger's recorded leaf/sink
// output at any path the two op-tree shapes happen to share. Every direct
// runInline caller that doesn't pass one (every test, and any host embedding
// this library in-process) defaults to '', which folds back to the exact
// pre-#398 (runId, path) key -- only src/adapters/op-run.ts (the actual
// network-exposed surface a runId can be guessed/replayed against) computes a
// real one, from the caller-supplied OpSpec JSON (not the built Op tree --
// buildOp's mergeParams closes a leaf spec's `params` over the piped value,
// so those params never appear as an enumerable field on the built tree) and
// root input.
//
// `input` (#234) is the node's own input value, passed in explicitly (not
// just captured inside `fn`'s closure) so that, when gOpts.traceSnapshots is
// also set, it can be handed to snapshotValue alongside `fn`'s result -- a
// second, separately-gated cost layered on top of the timing/ok/error trace
// (see trace.ts's header comment).
//
// \0 can't appear in a caller-supplied runId/runSig (a UUID or hex digest),
// so this can't collide with an unnamespaced key -- and when runSig is ''
// (the default for every caller that doesn't opt in), this reduces to the
// bare `runId` used before #398, unchanged. Exported so a cheap status query
// (src/adapters/op-run.ts's runOpSpecStatus, #409) can address the exact
// same root-node ((runId, runSig), '') entry traced() itself writes, without
// re-deriving this namespacing rule at a second call site.
export function checkpointKey(runId: string, runSig: string): string {
  return runSig ? `${runId}\0${runSig}` : runId
}

async function traced<T>(tag: string, name: string | undefined, path: string, runId: string, runSig: string, caps: Caps, gOpts: RunGovernedOpts | undefined, input: unknown, fn: (callId: string) => Promise<T>): Promise<T> {
  // Cooperative-cancellation checkpoint (#279): every node runInline
  // dispatches -- leaf, pipe step, map/mapField item, reconcile, sink
  // fanout/target, ask, catch's try -- passes through here before it starts,
  // so one check here is equivalent to a check at every one of those sites.
  if (gOpts?.signal?.aborted) throw new OpAbortError()
  const checkpoint = caps.checkpoint
  const checkpointRunId = checkpointKey(runId, runSig)
  if (checkpoint) {
    const recorded = await checkpoint.get(checkpointRunId, path)
    if (recorded?.done) return recorded.value as T
  }
  const callId = String(++traceCallSeq)
  const run = async (): Promise<T> => {
    if (checkpoint) await checkpoint.start(checkpointRunId, path)
    const result = await fn(callId)
    if (checkpoint) await checkpoint.put(checkpointRunId, path, result)
    return result
  }
  const onTrace = gOpts?.onTrace
  if (!onTrace) return run()
  const t0 = caps.clock.now()
  const inputRef = gOpts?.traceSnapshots ? await snapshotValue(caps.store, input) : undefined
  onTrace({ kind: 'node-enter', tag, name, path, runId, callId, ...(inputRef ? { inputRef } : {}) })
  try {
    const result = await run()
    const outputRef = gOpts?.traceSnapshots ? await snapshotValue(caps.store, result) : undefined
    onTrace({ kind: 'node-exit', tag, name, path, runId, callId, durationMs: caps.clock.now() - t0, ok: true, ...(outputRef ? { outputRef } : {}) })
    return result
  } catch (err) {
    onTrace({ kind: 'node-exit', tag, name, path, runId, callId, durationMs: caps.clock.now() - t0, ok: false, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

// `runId` (#346) is minted once, at the top-level call (the only caller that
// omits it -- every recursive runInline call below passes its own already-
// minted `runId` straight through), and stamped onto every TraceEvent for
// that call via traced() above. This is what lets a consumer sharing one
// onTrace sink across concurrent runInline calls (src/adapters/otel.ts's
// exporters) tell those calls' events apart even when their windows overlap
// without nesting and they visit the exact same relative `path`.
//
// `runSig` (#398) is threaded through every recursive call the exact same
// way -- see traced()'s header comment above for what it binds and why.
export async function runInline(node: Op, input: any, caps: Caps, gOpts?: RunGovernedOpts, path = '', runId: string = crypto.randomUUID(), runSig = ''): Promise<any> {
  switch (node.tag) {
    case 'leaf':
      return traced('leaf', node.name, path, runId, runSig, caps, gOpts, input, (callId) =>
        runGoverned(node.name, node.opts, node.fn, input, caps, caps.governors?.[node.name], gOpts, runId, callId))
    case 'pipe':
      return traced('pipe', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        let v = input
        for (let i = 0; i < node.steps.length; i++) v = await runInline(node.steps[i], v, caps, gOpts, childPath(path, i), runId, runSig)
        return v
      })
    case 'map':
      return traced('map', undefined, path, runId, runSig, caps, gOpts, input, async (callId) => {
        const items: any[] = input; const out = new Array(items.length)
        // Promise.allSettled, not Promise.all -- see the 'sink' case below for
        // why: an item's own runInline call may still be mid-flight (e.g.
        // gated through runGoverned's idempotencyKey digest) when a sibling
        // item throws, and Promise.all would resolve/reject before that
        // slower item's node-exit trace has landed.
        const results = await Promise.allSettled(items.map(async (it, i) => {
          await node.concurrency.acquire(gOpts?.signal)
          let result: any
          try { result = await runInline(node.op, it, caps, gOpts, childPath(path, i), runId, runSig) }
          catch (e) { releaseOnItemCatch(node.concurrency, e, runId, callId); throw e }
          // Post-success release deliberately sits outside the try/catch above,
          // same as runGoverned's #275 fix -- a throw here (e.g. a host onEvent
          // callback) must not be misclassified as an item failure, which would
          // double-release the concurrency slot.
          out[i] = result
          node.concurrency.release(true, runId, callId)
        }))
        throwFirstOrAggregate(results, 'map')
        return out
      })
    case 'mapField':
      return traced('mapField', undefined, path, runId, runSig, caps, gOpts, input, async (callId) => {
        const obj = input as Record<string, unknown>
        const items = obj[node.arrayField] as any[]
        const out = new Array(items.length)
        const results = await Promise.allSettled(items.map(async (it, i) => {
          await node.concurrency.acquire(gOpts?.signal)
          let value: any
          try { value = await runInline(node.op, (it as Record<string, unknown>)[node.elementField], caps, gOpts, childPath(path, i), runId, runSig) }
          catch (e) { releaseOnItemCatch(node.concurrency, e, runId, callId); throw e }
          // Post-success release outside try/catch, same reasoning as 'map' above.
          out[i] = { ...(it as Record<string, unknown>), [node.elementField]: value }
          node.concurrency.release(true, runId, callId)
        }))
        throwFirstOrAggregate(results, 'mapField')
        const { [node.arrayField]: _dropped, ...rest } = obj
        const targetField = node.renameTo ?? node.arrayField
        // A renameTo naming a field that survives the arrayField drop would
        // silently clobber that field via object-spread's later-key-wins
        // semantics -- reject it explicitly instead.
        if (node.renameTo !== undefined && node.renameTo !== node.arrayField && Object.prototype.hasOwnProperty.call(rest, targetField)) {
          throw new Error(`mapField's renameTo "${targetField}" collides with an existing field on the input object`)
        }
        return { ...rest, [targetField]: out }
      })
    case 'reconcile':
      return traced('reconcile', undefined, path, runId, runSig, caps, gOpts, input, () => runReconcile(node.opts, input, caps.store))
    case 'sink':
      // Traced per-target, not just once for the whole fanout: Promise.allSettled
      // (not Promise.all -- which would resolve as soon as the first target
      // rejects, racing ahead of a slower target's own node-exit push, since
      // each write is now gated through runGoverned below and idempotencyKey's
      // crypto.subtle.digest call is real async work, not just a microtask)
      // gives every target's write equal opportunity to fail independently and
      // guarantees every target's node-exit has landed before this node decides
      // success/failure.
      return traced('sink', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        const results = await Promise.allSettled(node.targets.map((t, i) => {
          // A bare string target falls back entirely to the fanout call's own
          // `opts`; a `{ name, opts }` pair overrides per-field, per-target
          // (#251) -- e.g. target 'vault' can opt out of the fanout's default
          // retries by declaring its own `opts: { retries: 0 }`.
          const name = typeof t === 'string' ? t : t.name
          const targetOpts = typeof t === 'string' ? undefined : t.opts
          // Keyed by index, not name (#423): sink.fanout(['a', 'a']) is valid
          // (src/op/spec.ts never rejects duplicate target names), so two
          // concurrent targets sharing a name would otherwise collide on one
          // childPath(path, name) checkpoint key -- a resume after a crash
          // between the two writes would then read the first write's
          // recorded value for both, silently never re-attempting the second
          // target's write. The array index is deterministic across resumes
          // of the same OpSpec, unlike callId (a fresh per-process counter),
          // so it's safe to use as a durable checkpoint path segment, the
          // same way map/mapField already key their per-item paths by index.
          return traced('sink-target', name, childPath(path, i), runId, runSig, caps, gOpts, input, async (callId) => {
            const s = caps.sinks[name]
            if (!s) throw new Error(`unknown sink "${name}" (registered: ${Object.keys(caps.sinks).join(', ')})`)
            // Each write runs through runGoverned exactly like an 'effect' leaf's
            // fn -- retries/breaker/tokenBucket/concurrency -- keyed `sink:<target>`
            // in caps.governors so a sink target's gating can't collide with a
            // same-named leaf's own governor entry.
            const governorName = `sink:${name}`
            const opts = {
              kind: 'effect' as const,
              retries: targetOpts?.retries ?? node.opts?.retries,
              heavy: targetOpts?.heavy ?? node.opts?.heavy,
              memo: targetOpts?.memo ?? node.opts?.memo,
            }
            return runGoverned(governorName, opts, (v, c) => s.write(v, c), input, caps, caps.governors?.[governorName], gOpts, runId, callId)
          })
        }))
        throwFirstOrAggregate(results, 'sink')
        return input
      })
    case 'ask':
      return traced('ask', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        // No Ask capability: there is no way to pause for a human answer, so an
        // immediate "timeout" is the honest default -- honor onTimeout rather than
        // silently overriding a caller's explicit 'fail' contract with 'proceed'.
        if (!caps.ask) {
          if (node.onTimeout === 'fail') throw new AskTimeoutError(node.prompt)
          return input
        }
        const result = await caps.ask.request(node.prompt, node.timeout)
        if (result.answered) return result.value !== undefined ? result.value : input
        if (node.onTimeout === 'fail') throw new AskTimeoutError(node.prompt)
        return input
      })
    case 'catch':
      // The try branch's own node-exit (path `${path}/try`) carries ok:false
      // and the discarded error's message -- that's what answers "why did the
      // fallback fire" when a caller supplies onTrace; this case itself still
      // only needs the error to decide whether to run the fallback.
      return traced('catch', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        try { return await runInline(node.try, input, caps, gOpts, childPath(path, 'try'), runId, runSig) }
        catch (err) {
          // An abort is a control signal from outside the tree, not an
          // application error -- it must propagate past catch's fallback,
          // not be swallowed as "the try branch failed, run the fallback."
          if (err instanceof OpAbortError) throw err
          return runInline(node.catch, input, caps, gOpts, childPath(path, 'catch'), runId, runSig)
        }
      })
    case 'cond':
      return traced('cond', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        for (let i = 0; i < node.cases.length; i++) {
          if (evalCondPredicate(node.cases[i].when, input)) {
            return runInline(node.cases[i].then, input, caps, gOpts, childPath(path, i), runId, runSig)
          }
        }
        if (node.default) return runInline(node.default, input, caps, gOpts, childPath(path, 'default'), runId, runSig)
        throw new Error('cond: no case matched and no default branch was supplied')
      })
    case 'parallel':
      // Promise.allSettled, same race-safety reasoning as 'map'/'sink' above:
      // a branch's own runInline call may still be mid-flight when a sibling
      // branch throws, and Promise.all would resolve/reject before that
      // slower branch's own node-exit trace has landed. Each branch already
      // gets its own trace/governor treatment via its own runInline
      // recursion (a leaf, pipe, etc. at childPath(path, i)) -- no separate
      // per-branch traced() wrapper needed here, same as 'map's items.
      return traced('parallel', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        const out = new Array(node.ops.length)
        const results = await Promise.allSettled(node.ops.map(async (op, i) => {
          out[i] = await runInline(op, input, caps, gOpts, childPath(path, i), runId, runSig)
        }))
        throwFirstOrAggregate(results, 'parallel')
        return out
      })
    case 'race':
      // Unlike every fan-out above, this deliberately does NOT await
      // Promise.allSettled over every branch first -- the whole point of a
      // race is to settle before all branches finish. A manual Promise
      // wraps node.ops.forEach, resolving/rejecting the moment the outcome
      // is decided (quorum met, or mathematically unreachable) rather than
      // once every branch happens to be done.
      //
      // A still-running losing branch's own runInline call is left to
      // settle on its own -- its eventual node-exit trace (if any) lands
      // after this node's, which is fine (see the map/sink/parallel cases
      // above for why per-branch tracing usually waits for allSettled first
      // -- that reasoning is about not truncating a *slower success* against
      // Promise.all's early-reject, not about a race intentionally settling
      // early). `if (done) return` at the top of each branch's callback
      // stops it from mutating `wins`/rejecting again once the outcome is
      // already decided, so a stray late settlement can't corrupt the
      // already-resolved `wins` array (arrays resolve by reference) or
      // double-settle this node's own promise.
      return traced('race', undefined, path, runId, runSig, caps, gOpts, input, async () => {
        const need = node.need ?? 1
        const total = node.ops.length
        // buildOp/validateOpSpec (src/op/spec.ts) already reject `need >
        // ops.length` for anything built from an OpSpec, but a hand-built Op
        // tree (a host calling the `race()` combinator directly) skips that
        // check -- without this, every branch succeeding would still never
        // reach `wins.length >= need`, and nothing else here would ever
        // settle this node's promise, hanging forever.
        if (need > total) throw new Error(`race: \`need\` (${need}) exceeds its \`ops\` array's length (${total})`)
        // Cooperative-cancellation signal for the losing branches (#279's
        // contract, same as everywhere else in this file): aborting this
        // only stops a branch from *starting* its next step once the race
        // settles -- an already in-flight leaf/sink write still runs to
        // completion, it's never preemptively killed. Chained off the
        // caller's own signal (if any) so an outer abort still reaches every
        // branch, not just ones that happen to check gOpts.signal directly.
        const raceController = new AbortController()
        if (gOpts?.signal) {
          if (gOpts.signal.aborted) raceController.abort()
          else gOpts.signal.addEventListener('abort', () => raceController.abort(), { once: true })
        }
        const branchGOpts: RunGovernedOpts = { ...gOpts, signal: raceController.signal }
        return new Promise((resolve, reject) => {
          const wins: any[] = []
          const failures: unknown[] = []
          let settled = 0
          let done = false
          node.ops.forEach((branchOp, i) => {
            runInline(branchOp, input, caps, branchGOpts, childPath(path, i), runId, runSig).then(
              (v) => {
                settled++
                if (done) return
                wins.push(v)
                // need:1 (the default, "first success wins") resolves the
                // bare winning value instead of a length-1 array -- matching
                // cond/catch's convention of resolving to whichever single
                // branch actually ran, and JS's own Promise.any, rather than
                // forcing every caller to unwrap `result[0]` for the common
                // case (#431). need > 1 still collects the full quorum into
                // an array, since there's no single bare value to resolve.
                if (wins.length >= need) { done = true; raceController.abort(); resolve(need === 1 ? wins[0] : wins) }
              },
              (e) => {
                settled++
                if (done) return
                failures.push(e)
                // Unreachable the moment even a best case (every still-pending
                // branch succeeds) couldn't reach `need` -- no reason to wait
                // out the remaining stragglers once that's certain.
                if (wins.length + (total - settled) < need) {
                  done = true; raceController.abort()
                  reject(failures.length === 1 ? failures[0] : new AggregateError(failures, `race: only ${wins.length} of ${need} needed branches succeeded (${total} total, ${failures.length} failed)`))
                }
              },
            )
          })
        })
      })
  }
}
