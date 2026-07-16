import type { Op, LeafFn, LeafOpts, Concurrency } from './types.js'
import type { ReconcileOpts } from './reconcile.js'
export const op = (name: string, fn: LeafFn, opts: LeafOpts): Op => ({ tag: 'leaf', name, fn, opts })
export const pipe = (...steps: Op[]): Op => ({ tag: 'pipe', steps })
export const map = (inner: Op, o: { concurrency: Concurrency }): Op => ({ tag: 'map', op: inner, concurrency: o.concurrency })
export const reconcile = (opts: ReconcileOpts): Op => ({ tag: 'reconcile', opts })
export const sink = Object.assign(
  (name: string): Op => ({ tag: 'sink', targets: [name] }),
  { fanout: (...names: string[]): Op => ({ tag: 'sink', targets: names }) },
)
export const ask = (prompt: string, o: { timeout: string; onTimeout: 'proceed' | 'fail' }): Op =>
  ({ tag: 'ask', prompt, timeout: o.timeout, onTimeout: o.onTimeout })
