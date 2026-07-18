import type { Op, LeafOpts } from './types.js'
import { op, pipe, map } from './combinators.js'
import { resolveLeaf } from './registry.js'
import { fixed } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: number }

// Retries/concurrency caps for adapter-triggered runs: generous enough for a
// real multi-step job, tight enough that a bad spec can't turn one request
// into an unbounded retry storm or a huge fan-out.
const MAX_LEAF_RETRIES = 5
const MAX_MAP_CONCURRENCY = 32

/**
 * Builds a real Op tree from a caller-supplied JSON description, resolving
 * every leaf name against the registry -- a spec can never carry a live `fn`,
 * only a name. Deliberately supports just `leaf`/`pipe`/`map`: `reconcile`,
 * `sink`, and `ask` all depend on host-provided capabilities (a sink target,
 * an Ask implementation) that a stateless adapter call has no way to supply,
 * so composing those still requires building an Op tree in-process.
 */
export function buildOp(spec: OpSpec): Op {
  if (!spec || typeof spec !== 'object') throw new Error('op spec must be an object')
  switch (spec.tag) {
    case 'leaf': {
      if (typeof spec.name !== 'string' || !spec.name) throw new Error('leaf spec requires a `name`')
      const fn = resolveLeaf(spec.name)
      const o = spec.opts ?? {}
      if (o.retries !== undefined && (!Number.isInteger(o.retries) || o.retries < 0 || o.retries > MAX_LEAF_RETRIES)) {
        throw new Error(`leaf "${spec.name}": \`retries\` must be an integer between 0 and ${MAX_LEAF_RETRIES}`)
      }
      const opts: LeafOpts = { kind: o.kind ?? 'effect', retries: o.retries ?? 0, heavy: o.heavy, memo: o.memo }
      return op(spec.name, fn, opts)
    }
    case 'pipe': {
      if (!Array.isArray(spec.steps) || !spec.steps.length) throw new Error('pipe spec requires a non-empty `steps` array')
      return pipe(...spec.steps.map(buildOp))
    }
    case 'map': {
      if (!spec.op) throw new Error('map spec requires an `op`')
      if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > MAX_MAP_CONCURRENCY) {
        throw new Error(`map spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}`)
      }
      return map(buildOp(spec.op), { concurrency: fixed(spec.concurrency) })
    }
    default:
      throw new Error(`unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: leaf, pipe, map)`)
  }
}
