import type { Op, LeafFn, LeafOpts } from './types.js'
import type { ReconcileOpts } from './reconcile.js'
import { op, pipe, map, sink, reconcile } from './combinators.js'
import { resolveLeaf, LEAF_SHAPES, type LeafShape } from './registry.js'
import { fixed } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts; params?: Record<string, unknown> }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: number }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'sink'; targets: string[] }

const RECONCILE_MODES = new Set(['faithful-union', 'last-write-wins', 'field-merge'])

/** reconcile always consumes the Handle[] a prior map/unzip step produced and always emits one merged Handle (runReconcile, src/op/reconcile.ts) -- fixed regardless of `opts.mode`. */
const RECONCILE_SHAPE: { input: LeafShape; output: LeafShape } = { input: 'handle[]', output: 'handle' }

function stepShape(s: OpSpec, side: 'input' | 'output'): LeafShape {
  if (s.tag === 'leaf') return LEAF_SHAPES[s.name]?.[side] ?? 'unknown'
  if (s.tag === 'reconcile') return RECONCILE_SHAPE[side]
  return 'unknown'
}

function shapeLabel(s: LeafShape): string {
  if (s === 'unknown' || s === 'handle' || s === 'handle[]') return s
  return `{${Object.keys(s.object).join(', ')}}`
}

function shapeCompatible(output: LeafShape, input: LeafShape): boolean {
  if (output === 'unknown' || input === 'unknown') return true
  if (typeof output === 'string' || typeof input === 'string') return output === input
  return Object.entries(input.object).every(([k, v]) => v !== 'handle' || output.object[k] === 'handle')
}

function stepLabel(s: OpSpec): string {
  return s.tag === 'leaf' ? s.name : s.tag
}

// Retries/concurrency caps for adapter-triggered runs: generous enough for a
// real multi-step job, tight enough that a bad spec can't turn one request
// into an unbounded retry storm or a huge fan-out.
const MAX_LEAF_RETRIES = 5
const MAX_MAP_CONCURRENCY = 32

/**
 * Shallow-merges a leaf spec's static `params` onto the piped value flowing
 * into that leaf at run time -- e.g. supplying convert's required `to`/`from`
 * onto whatever wrapHandle produced, closing the gap CLAUDE.md's "Leaf
 * composability gotcha" flags: a JSON OpSpec has no other way to hand a leaf
 * a required, non-optional opt. Only merges onto an object (not array)
 * input; anything else passes through with params ignored, since there's no
 * sensible shallow merge target. `__proto__`/`constructor`/`prototype` are
 * skipped the same way op-run.ts's hydrate() and reconcile.ts's fieldMerge
 * already guard untrusted JSON keys -- `params` comes from the same
 * caller-supplied spec JSON they do.
 */
function mergeParams(input: unknown, params: Record<string, unknown>): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const [k, v] of Object.entries(params)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    out[k] = v
  }
  return out
}

/**
 * Builds a real Op tree from a caller-supplied JSON description, resolving
 * every leaf name against the registry -- a spec can never carry a live `fn`,
 * only a name. Supports `leaf`/`pipe`/`map`/`reconcile`/`sink`: a `sink` spec
 * only carries target *names*, resolved against Caps.sinks at run time
 * (runInline's `case 'sink'`) the same way it already works for an in-process
 * caller -- see SINK_REGISTRY (./sinks.ts) and OpRunOpts.sinks
 * (../adapters/op-run.ts) for where those names come from. `reconcile`'s opts
 * (src/op/reconcile.ts) are plain JSON and it only touches `caps.store`,
 * which every adapter call already supplies, so it needs no such indirection.
 * `ask` still depends on a live host-provided Ask implementation that a
 * stateless adapter call has no way to supply, so composing that still
 * requires building an Op tree in-process.
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
      if (spec.params !== undefined && (typeof spec.params !== 'object' || spec.params === null || Array.isArray(spec.params))) {
        throw new Error(`leaf "${spec.name}": \`params\` must be an object`)
      }
      const opts: LeafOpts = { kind: o.kind ?? 'effect', retries: o.retries ?? 0, heavy: o.heavy, memo: o.memo }
      const params = spec.params
      const leafFn: LeafFn = params ? (input, caps, idempotencyKey) => fn(mergeParams(input, params), caps, idempotencyKey) : fn
      return op(spec.name, leafFn, opts)
    }
    case 'pipe': {
      if (!Array.isArray(spec.steps) || !spec.steps.length) throw new Error('pipe spec requires a non-empty `steps` array')
      for (let i = 0; i + 1 < spec.steps.length; i++) {
        const prev = spec.steps[i]; const next = spec.steps[i + 1]
        const output = stepShape(prev, 'output'); const input = stepShape(next, 'input')
        if (!shapeCompatible(output, input)) {
          throw new Error(
            `pipe step ${i + 1} ("${stepLabel(next)}") expects ${shapeLabel(input)} input, but step ${i} ` +
            `("${stepLabel(prev)}") produces ${shapeLabel(output)}`,
          )
        }
      }
      return pipe(...spec.steps.map(buildOp))
    }
    case 'map': {
      if (!spec.op) throw new Error('map spec requires an `op`')
      if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > MAX_MAP_CONCURRENCY) {
        throw new Error(`map spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}`)
      }
      return map(buildOp(spec.op), { concurrency: fixed(spec.concurrency) })
    }
    case 'reconcile': {
      if (!spec.opts || typeof spec.opts !== 'object' || !RECONCILE_MODES.has(spec.opts.mode)) {
        throw new Error(`reconcile spec's \`opts.mode\` must be one of: ${[...RECONCILE_MODES].join(', ')}`)
      }
      return reconcile(spec.opts)
    }
    case 'sink': {
      if (!Array.isArray(spec.targets) || !spec.targets.length || !spec.targets.every((t) => typeof t === 'string' && t)) {
        throw new Error('sink spec requires a non-empty `targets` array of non-empty strings')
      }
      return sink.fanout(...spec.targets)
    }
    default:
      throw new Error(`unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: leaf, pipe, map, reconcile, sink)`)
  }
}
