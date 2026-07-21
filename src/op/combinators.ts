import type { Op, LeafFn, LeafOpts, SinkOpts, SinkFanoutTarget, Concurrency, CondPredicate } from './types.js'
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
// Data-driven success-path routing, complementing catch's error-path routing (#196):
// evaluates each case's `when` predicate against the piped value in order, running
// the first match's `then` branch; falls through to `default` (or throws) when none
// match. Named `cond`, not a reserved word, unlike catchOp's `catch`.
export const cond = (cases: { when: CondPredicate; then: Op }[], defaultOp?: Op): Op =>
  ({ tag: 'cond', cases, ...(defaultOp ? { default: defaultOp } : {}) })
// Runs every op in `ops` concurrently over the same input, collecting results
// into an array in `ops` order -- complements map (one op, N array elements)
// with the opposite shape: N ops, one shared input (#289).
export const parallel = (ops: Op[]): Op => ({ tag: 'parallel', ops })
// Like `parallel`, but settles once `need` (default 1) branches succeed
// instead of waiting for all of them -- a quorum/first-success-wins fan-out
// (#429). `need` is validated against `ops.length` at build time
// (buildOp/validateOpSpec, ./spec.ts), not here -- this combinator, like
// `cond`/`parallel` before it, is a plain structural constructor.
export const race = (ops: Op[], opts?: { need?: number }): Op => ({ tag: 'race', ops, ...(opts?.need !== undefined ? { need: opts.need } : {}) })
