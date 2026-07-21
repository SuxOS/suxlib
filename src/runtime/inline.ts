import type { Op, Caps } from '../op/types.js'
import { runReconcile } from '../op/reconcile.js'
import { runGoverned, OpAbortError, type RunGovernedOpts } from '../control/governor.js'

export class AskTimeoutError extends Error {
  constructor(readonly prompt: string) {
    super(`ask timed out with no answer: "${prompt}"`)
    this.name = 'AskTimeoutError'
  }
}

const childPath = (path: string, seg: string | number): string => (path === '' ? String(seg) : `${path}/${seg}`)

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
// all, and persists its result after. A hit short-circuits entirely (no
// callId minted, no trace event, no governor call, `fn` never invoked), so a
// runInline call sharing a prior run's runId skips re-executing any subtree
// already recorded -- a completed leaf, sink target, or a whole finished
// composite node. Since `path` already addresses individual map/mapField
// items and sink fanout targets, this gives partial-fanout resume for free:
// only the still-unfinished items of an in-flight fan-out actually re-run.
// With no caps.checkpoint (the common case), this is a pure no-op -- same
// degrade-gracefully contract as caps.ask/caps.cache.
async function traced<T>(tag: string, name: string | undefined, path: string, runId: string, caps: Caps, gOpts: RunGovernedOpts | undefined, fn: (callId: string) => Promise<T>): Promise<T> {
  // Cooperative-cancellation checkpoint (#279): every node runInline
  // dispatches -- leaf, pipe step, map/mapField item, reconcile, sink
  // fanout/target, ask, catch's try -- passes through here before it starts,
  // so one check here is equivalent to a check at every one of those sites.
  if (gOpts?.signal?.aborted) throw new OpAbortError()
  const checkpoint = caps.checkpoint
  if (checkpoint) {
    const recorded = await checkpoint.get(runId, path)
    if (recorded) return recorded.value as T
  }
  const callId = String(++traceCallSeq)
  const run = async (): Promise<T> => {
    const result = await fn(callId)
    if (checkpoint) await checkpoint.put(runId, path, result)
    return result
  }
  const onTrace = gOpts?.onTrace
  if (!onTrace) return run()
  const t0 = caps.clock.now()
  onTrace({ kind: 'node-enter', tag, name, path, runId, callId })
  try {
    const result = await run()
    onTrace({ kind: 'node-exit', tag, name, path, runId, callId, durationMs: caps.clock.now() - t0, ok: true })
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
export async function runInline(node: Op, input: any, caps: Caps, gOpts?: RunGovernedOpts, path = '', runId: string = crypto.randomUUID()): Promise<any> {
  switch (node.tag) {
    case 'leaf':
      return traced('leaf', node.name, path, runId, caps, gOpts, (callId) =>
        runGoverned(node.name, node.opts, node.fn, input, caps, caps.governors?.[node.name], gOpts, runId, callId))
    case 'pipe':
      return traced('pipe', undefined, path, runId, caps, gOpts, async () => {
        let v = input
        for (let i = 0; i < node.steps.length; i++) v = await runInline(node.steps[i], v, caps, gOpts, childPath(path, i), runId)
        return v
      })
    case 'map':
      return traced('map', undefined, path, runId, caps, gOpts, async (callId) => {
        const items: any[] = input; const out = new Array(items.length)
        // Promise.allSettled, not Promise.all -- see the 'sink' case below for
        // why: an item's own runInline call may still be mid-flight (e.g.
        // gated through runGoverned's idempotencyKey digest) when a sibling
        // item throws, and Promise.all would resolve/reject before that
        // slower item's node-exit trace has landed.
        const results = await Promise.allSettled(items.map(async (it, i) => {
          await node.concurrency.acquire(gOpts?.signal)
          let result: any
          try { result = await runInline(node.op, it, caps, gOpts, childPath(path, i), runId) }
          catch (e) { node.concurrency.release(false, runId, callId); throw e }
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
      return traced('mapField', undefined, path, runId, caps, gOpts, async (callId) => {
        const obj = input as Record<string, unknown>
        const items = obj[node.arrayField] as any[]
        const out = new Array(items.length)
        const results = await Promise.allSettled(items.map(async (it, i) => {
          await node.concurrency.acquire(gOpts?.signal)
          let value: any
          try { value = await runInline(node.op, (it as Record<string, unknown>)[node.elementField], caps, gOpts, childPath(path, i), runId) }
          catch (e) { node.concurrency.release(false, runId, callId); throw e }
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
      return traced('reconcile', undefined, path, runId, caps, gOpts, () => runReconcile(node.opts, input, caps.store))
    case 'sink':
      // Traced per-target, not just once for the whole fanout: Promise.allSettled
      // (not Promise.all -- which would resolve as soon as the first target
      // rejects, racing ahead of a slower target's own node-exit push, since
      // each write is now gated through runGoverned below and idempotencyKey's
      // crypto.subtle.digest call is real async work, not just a microtask)
      // gives every target's write equal opportunity to fail independently and
      // guarantees every target's node-exit has landed before this node decides
      // success/failure.
      return traced('sink', undefined, path, runId, caps, gOpts, async () => {
        const results = await Promise.allSettled(node.targets.map(t => {
          // A bare string target falls back entirely to the fanout call's own
          // `opts`; a `{ name, opts }` pair overrides per-field, per-target
          // (#251) -- e.g. target 'vault' can opt out of the fanout's default
          // retries by declaring its own `opts: { retries: 0 }`.
          const name = typeof t === 'string' ? t : t.name
          const targetOpts = typeof t === 'string' ? undefined : t.opts
          return traced('sink-target', name, childPath(path, name), runId, caps, gOpts, async (callId) => {
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
      return traced('ask', undefined, path, runId, caps, gOpts, async () => {
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
      return traced('catch', undefined, path, runId, caps, gOpts, async () => {
        try { return await runInline(node.try, input, caps, gOpts, childPath(path, 'try'), runId) }
        catch (err) {
          // An abort is a control signal from outside the tree, not an
          // application error -- it must propagate past catch's fallback,
          // not be swallowed as "the try branch failed, run the fallback."
          if (err instanceof OpAbortError) throw err
          return runInline(node.catch, input, caps, gOpts, childPath(path, 'catch'), runId)
        }
      })
  }
}
