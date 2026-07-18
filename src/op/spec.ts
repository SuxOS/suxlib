import type { Op, LeafFn, LeafOpts } from './types.js'
import { op, pipe, map } from './combinators.js'
import { resolveLeaf, LEAF_SHAPES, type LeafShape } from './registry.js'
import { fixed } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts; params?: Record<string, unknown> }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: number }

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
 * A step's declared boundary shape, walked outward from its own `leaf`
 * lookup or (recursively) its first/last child step -- `map`'s shape is
 * always 'unknown' since its element-wise behavior isn't expressible in
 * LeafShape (there's no "array of X" beyond the fixed 'handle[]' case), so a
 * mismatch inside a `map`'s inner `op` is still caught (buildOp recurses
 * into it), just not the map's own boundary against its pipe neighbors.
 */
function outputShapeOf(spec: OpSpec): LeafShape {
  if (spec.tag === 'leaf') return LEAF_SHAPES[spec.name]?.output ?? 'unknown'
  if (spec.tag === 'pipe') return spec.steps.length ? outputShapeOf(spec.steps[spec.steps.length - 1]) : 'unknown'
  return 'unknown'
}

function inputShapeOf(spec: OpSpec): LeafShape {
  if (spec.tag === 'leaf') return LEAF_SHAPES[spec.name]?.input ?? 'unknown'
  if (spec.tag === 'pipe') return spec.steps.length ? inputShapeOf(spec.steps[0]) : 'unknown'
  return 'unknown'
}

// 'unknown' on either side always matches -- it means "this scheme can't
// describe the shape", not "expects nothing", so treating it as a mismatch
// would false-positive on pack/unpack's non-Handle fields. A `handle`/
// `handle[]` input only matches the identical output tag; an `{object}`
// input only checks its `'handle'`-typed fields are present as `'handle'` on
// the output side (an `'unknown'`-typed field is a "don't care", same as
// top-level 'unknown') -- this deliberately doesn't require the shapes to
// match exactly, just that every field the consumer actually reads as a
// Handle is one on the producer's side too.
function shapesCompatible(output: LeafShape, input: LeafShape): boolean {
  if (input === 'unknown' || output === 'unknown') return true
  if (input === 'handle' || input === 'handle[]') return output === input
  if (typeof output !== 'object') return false
  return Object.entries(input.object).every(([key, kind]) => kind === 'unknown' || output.object[key] === 'handle')
}

function describeShape(shape: LeafShape): string {
  if (shape === 'handle') return 'a bare Handle'
  if (shape === 'handle[]') return 'a Handle[]'
  if (shape === 'unknown') return 'an unvalidated shape'
  const handleFields = Object.entries(shape.object).filter(([, kind]) => kind === 'handle').map(([key]) => key)
  return `{${handleFields.join(', ')}}`
}

function describeStep(spec: OpSpec): string {
  return spec.tag === 'leaf' ? `"${spec.name}"` : `a \`${spec.tag}\` step`
}

/**
 * Walks a pipe's consecutive step pairs and throws a build-time error naming
 * the mismatched pair, instead of letting an incompatible chain (e.g.
 * `convert` straight into `unwrapHandle`, per CLAUDE.md's "Leaf composability
 * gotcha") reach `runInline` and fail opaquely (or silently produce
 * `undefined`, per #132) deep inside a run.
 */
function validatePipeShapes(steps: OpSpec[]): void {
  for (let i = 1; i < steps.length; i++) {
    const producedShape = outputShapeOf(steps[i - 1])
    const expectedShape = inputShapeOf(steps[i])
    if (!shapesCompatible(producedShape, expectedShape)) {
      throw new Error(
        `pipe step ${i}: ${describeStep(steps[i])} expects ${describeShape(expectedShape)}, but ` +
        `${describeStep(steps[i - 1])} produces ${describeShape(producedShape)}`,
      )
    }
  }
}

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
      validatePipeShapes(spec.steps)
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
