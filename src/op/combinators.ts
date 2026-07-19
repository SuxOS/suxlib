import type { Op, LeafFn, LeafOpts, SinkOpts, SinkFanoutTarget, Concurrency } from './types.js'
import type { ReconcileOpts } from './reconcile.js'
export const op = (name: string, fn: LeafFn, opts: LeafOpts): Op => ({ tag: 'leaf', name, fn, opts })
export const pipe = (...steps: Op[]): Op => ({ tag: 'pipe', steps })
export const map = (inner: Op, o: { concurrency: Concurrency }): Op => ({ tag: 'map', op: inner, concurrency: o.concurrency })
// Runs `inner` over one named field of each array element, passing the rest of the
// element through untouched -- closes #168: bridges an array-of-Handle-object field
// whose per-entry key name differs from a downstream leaf's own field name (e.g.
// unpack's `entries` -> pack's `files`) without a separate rename step, since `map`
// alone can only replace a whole element, not reshape+rename the array's own field.
export const mapField = (arrayField: string, elementField: string, inner: Op, o: { concurrency: Concurrency; renameTo?: string }): Op =>
  ({ tag: 'mapField', arrayField, elementField, op: inner, concurrency: o.concurrency, renameTo: o.renameTo })
// Fans one input into N arbitrary op subtrees concurrently, collecting their
// results into an array in `ops` order -- closes #289, the one remaining
// concurrent fan-out shape `map` (one-to-one over an array's elements) and
// `sink.fanout` (one input to N *sink targets*, not arbitrary Ops) don't
// cover. Typically feeds straight into `reconcile`, e.g.
// `pipe(parallel(transformA, transformB, transformC), reconcile({ mode: ... }))`.
export const parallel = (...ops: Op[]): Op => ({ tag: 'parallel', ops })
export const reconcile = (opts: ReconcileOpts): Op => ({ tag: 'reconcile', opts })
export const sink = Object.assign(
  (name: string, opts?: SinkOpts): Op => ({ tag: 'sink', targets: [name], ...(opts ? { opts } : {}) }),
  // `targets` accepts a mix of bare names and `{ name, opts }` pairs (#251) --
  // a bare name still falls back to this call's own `opts` (the pre-#251 shape).
  { fanout: (targets: SinkFanoutTarget[], opts?: SinkOpts): Op => ({ tag: 'sink', targets, ...(opts ? { opts } : {}) }) },
)
export const ask = (prompt: string, o: { timeout: string; onTimeout: 'proceed' | 'fail' }): Op =>
  ({ tag: 'ask', prompt, timeout: o.timeout, onTimeout: o.onTimeout })
// Runs `tryOp`; on any rejection (retries exhausted, CircuitOpenError, AskTimeoutError, or a
// plain leaf throw), re-runs `fallbackOp` against the *original* input instead of aborting the
// whole pipe -- closes #183. Named `catchOp`, not `catch`, since `catch` is a reserved word and
// can't be a const binding -- the Op tag itself is still 'catch'.
export const catchOp = (tryOp: Op, fallbackOp: Op): Op => ({ tag: 'catch', try: tryOp, catch: fallbackOp })
