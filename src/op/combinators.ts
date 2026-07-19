import type { Op, LeafFn, LeafOpts, Concurrency } from './types.js'
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
  (name: string): Op => ({ tag: 'sink', targets: [name] }),
  { fanout: (...names: string[]): Op => ({ tag: 'sink', targets: names }) },
)
export const ask = (prompt: string, o: { timeout: string; onTimeout: 'proceed' | 'fail' }): Op =>
  ({ tag: 'ask', prompt, timeout: o.timeout, onTimeout: o.onTimeout })
// Runs `tryOp`; on any rejection (retries exhausted, CircuitOpenError, AskTimeoutError, or a
// plain leaf throw), re-runs `fallbackOp` against the *original* input instead of aborting the
// whole pipe -- closes #183. Named `catchOp`, not `catch`, since `catch` is a reserved word and
// can't be a const binding -- the Op tag itself is still 'catch'.
export const catchOp = (tryOp: Op, fallbackOp: Op): Op => ({ tag: 'catch', try: tryOp, catch: fallbackOp })
