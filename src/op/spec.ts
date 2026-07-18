import type { Op, LeafFn, LeafOpts } from './types.js'
import type { ReconcileOpts, FieldPolicy } from './reconcile.js'
import { op, pipe, map, sink, reconcile } from './combinators.js'
import { resolveLeaf, mergeLeaves, LEAF_SHAPES, type LeafShape } from './registry.js'
import { fixed } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts; params?: Record<string, unknown> }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: number }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'reconcile'; opts: ReconcileOpts }

const FIELD_POLICIES: FieldPolicy[] = ['last-write-wins', 'union', 'keep-first']
const RECONCILE_MODES = ['faithful-union', 'last-write-wins', 'field-merge']

// Retries/concurrency caps for adapter-triggered runs: generous enough for a
// real multi-step job, tight enough that a bad spec can't turn one request
// into an unbounded retry storm or a huge fan-out.
const MAX_LEAF_RETRIES = 5
const MAX_MAP_CONCURRENCY = 32

function shapeLabel(s: LeafShape): string {
  if (s === 'unknown' || s === 'handle' || s === 'handle[]') return s
  return `{${Object.keys(s.object).join(', ')}}`
}

function shapeCompatible(output: LeafShape, input: LeafShape): boolean {
  if (output === 'unknown' || input === 'unknown') return true
  if (typeof output === 'string' || typeof input === 'string') return output === input
  return Object.entries(input.object).every(([k, v]) => v !== 'handle' || output.object[k] === 'handle')
}

/**
 * A pipe step's declared shape, for the one tag (`leaf`) LEAF_SHAPES actually
 * describes -- `map`/`pipe`/`sink` steps read as 'unknown' on both sides
 * rather than guessing: a `map` step's own boundary (its inner op's shape,
 * one array level up) is a real question with its own design surface (issue
 * #145's deliberate follow-up), and a nested `pipe`/`sink` step composing
 * multiple leaves has no single input/output shape without walking further
 * than a single adjacent-step comparison needs to.
 */
function stepShape(s: OpSpec, side: 'input' | 'output'): LeafShape {
  if (!s || typeof s !== 'object') return 'unknown'
  return s.tag === 'leaf' ? LEAF_SHAPES[s.name]?.[side] ?? 'unknown' : 'unknown'
}

function stepLabel(s: OpSpec): string {
  return s && typeof s === 'object' && s.tag === 'leaf' ? s.name : String((s as { tag?: unknown })?.tag)
}

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
 * only a name. Supports `leaf`/`pipe`/`map`/`sink`: a `sink` spec only carries
 * target *names*, resolved against Caps.sinks at run time (runInline's `case
 * 'sink'`) the same way it already works for an in-process caller -- see
 * SINK_REGISTRY (./sinks.ts) and OpRunOpts.sinks (../adapters/op-run.ts) for
 * where those names come from. `reconcile` only needs `caps.store` (already
 * supplied by every adapter call, see runInline's `case 'reconcile'`), so it's
 * expressible directly as an OpSpec variant. `ask` still depends on a live Ask
 * capability a stateless adapter call has no way to supply, so composing that
 * still requires building an Op tree in-process.
 *
 * `extraLeaves`, when supplied, merges host-registered leaves onto
 * LEAF_REGISTRY (mergeLeaves, ./registry.ts) once per top-level buildOp call
 * -- mirroring OpRunOpts.sinks -- and every recursive leaf-name resolution
 * within this spec (pipe steps, map's inner op) resolves against that same
 * merged table, not just the top-level node.
 *
 * A `pipe`'s adjacent steps are checked against each other's declared
 * LEAF_SHAPES (./registry.ts) before the tree is built, so a caller-supplied
 * shape mismatch (e.g. `unwrapHandle` straight after `convert`, #132) throws
 * a clear build-time error naming both steps instead of reaching `runInline`
 * and failing there -- sometimes silently, per #143. Only a *leaf* step's
 * shape is known; `map`/`pipe`/`sink` steps read as 'unknown' (permissively
 * compatible with anything) since their own boundary isn't modeled yet (see
 * stepShape's doc and issue #145).
 */
export function buildOp(spec: OpSpec, extraLeaves?: Record<string, LeafFn>): Op {
  return buildOpNode(spec, mergeLeaves(extraLeaves))
}

function buildOpNode(spec: OpSpec, leaves: Readonly<Record<string, LeafFn>>): Op {
  if (!spec || typeof spec !== 'object') throw new Error('op spec must be an object')
  switch (spec.tag) {
    case 'leaf': {
      if (typeof spec.name !== 'string' || !spec.name) throw new Error('leaf spec requires a `name`')
      const fn = resolveLeaf(spec.name, leaves)
      const o = spec.opts ?? {}
      if (o.retries !== undefined && (!Number.isInteger(o.retries) || o.retries < 0 || o.retries > MAX_LEAF_RETRIES)) {
        throw new Error(`leaf "${spec.name}": \`retries\` must be an integer between 0 and ${MAX_LEAF_RETRIES}`)
      }
      if (spec.params !== undefined && (typeof spec.params !== 'object' || spec.params === null || Array.isArray(spec.params))) {
        throw new Error(`leaf "${spec.name}": \`params\` must be an object`)
      }
      const opts: LeafOpts = { kind: o.kind ?? 'effect', retries: o.retries ?? 0, heavy: o.heavy, memo: o.memo }
      const params = spec.params
      const leafOp = op(spec.name, fn, opts)
      if (!params) return leafOp
      // Merge params in a preceding pure step rather than inside fn's own closure,
      // so a memoized leaf (opts.memo) computes its cache key -- runGoverned's
      // memoKey(name, input), see src/control/governor.ts -- from the *merged*
      // input. Folding params into fn's closure instead would let memoKey see only
      // the pre-merge piped value, hashing two differently-parameterized calls
      // (e.g. convert's `to: 'yaml'` vs `to: 'json'`) to the same key (#131).
      const mergeOp = op(`${spec.name}:params`, async (input) => mergeParams(input, params), { kind: 'pure', retries: 0 })
      return pipe(mergeOp, leafOp)
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
      return pipe(...spec.steps.map((s) => buildOpNode(s, leaves)))
    }
    case 'map': {
      if (!spec.op) throw new Error('map spec requires an `op`')
      if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > MAX_MAP_CONCURRENCY) {
        throw new Error(`map spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}`)
      }
      return map(buildOpNode(spec.op, leaves), { concurrency: fixed(spec.concurrency) })
    }
    case 'sink': {
      if (!Array.isArray(spec.targets) || !spec.targets.length || !spec.targets.every((t) => typeof t === 'string' && t)) {
        throw new Error('sink spec requires a non-empty `targets` array of non-empty strings')
      }
      return sink.fanout(...spec.targets)
    }
    case 'reconcile': {
      const o = spec.opts
      if (!o || typeof o !== 'object' || !RECONCILE_MODES.includes(o.mode as string)) {
        throw new Error(`reconcile spec's \`opts.mode\` must be one of: ${RECONCILE_MODES.join(', ')}`)
      }
      if (o.mode === 'field-merge') {
        if (o.defaultPolicy !== undefined && !FIELD_POLICIES.includes(o.defaultPolicy)) {
          throw new Error(`reconcile spec's \`opts.defaultPolicy\` must be one of: ${FIELD_POLICIES.join(', ')}`)
        }
        if (o.policy !== undefined) {
          if (typeof o.policy !== 'object' || o.policy === null || Array.isArray(o.policy)) {
            throw new Error('reconcile spec\'s `opts.policy` must be an object')
          }
          for (const [k, v] of Object.entries(o.policy)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
            if (!FIELD_POLICIES.includes(v)) throw new Error(`reconcile spec's \`opts.policy["${k}"]\` must be one of: ${FIELD_POLICIES.join(', ')}`)
          }
        }
      }
      return reconcile(o)
    }
    default:
      throw new Error(`unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: leaf, pipe, map, sink, reconcile)`)
  }
}
