import type { Op, LeafFn, LeafOpts } from './types.js'
import type { ReconcileOpts, FieldPolicy } from './reconcile.js'
import { op, pipe, map, mapField, sink, reconcile, catchOp, ask } from './combinators.js'
import { resolveLeaf, mergeLeaves, LEAF_SHAPES, type LeafShape, type LeafFieldShape } from './registry.js'
import { fixed } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts; params?: Record<string, unknown> }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: number }
  | { tag: 'mapField'; arrayField: string; elementField: string; op: OpSpec; concurrency: number; renameTo?: string }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'catch'; try: OpSpec; catch: OpSpec }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }

// Exported (not module-private) so mcp.ts's opSpecSchema and op/introspect.ts's
// describePipelineSchema derive their field-policy/reconcile-mode enums from
// this one array instead of hand-duplicating the literal strings -- the
// concrete drift CLAUDE.md's OpSpec-validation footgun note warns about (#187).
export const FIELD_POLICIES = ['last-write-wins', 'union', 'keep-first'] as const satisfies readonly FieldPolicy[]
export const RECONCILE_MODES = ['faithful-union', 'last-write-wins', 'field-merge'] as const satisfies readonly ReconcileOpts['mode'][]

// Retries/concurrency caps for adapter-triggered runs: generous enough for a
// real multi-step job, tight enough that a bad spec can't turn one request
// into an unbounded retry storm or a huge fan-out.
export const MAX_LEAF_RETRIES = 5
export const MAX_MAP_CONCURRENCY = 32

function shapeLabel(s: LeafShape): string {
  if (s === 'unknown' || s === 'handle' || s === 'handle[]') return s
  return `{${Object.keys(s.object).join(', ')}}`
}

/**
 * A field's own shape check, one level deeper than shapeCompatible's
 * top-level object comparison: a plain 'handle' field still just needs a
 * matching 'handle' on the output side, but an `arrayObject` field (pack's
 * `files`, unpack's `entries`, #161) needs the output side to also declare
 * an `arrayObject` whose handle-bearing keys line up -- same "'unknown' is
 * permissive, only a *declared* mismatch blocks" rule as the top level.
 */
function fieldCompatible(output: LeafFieldShape | undefined, input: LeafFieldShape): boolean {
  if (input === 'unknown') return true
  if (input === 'handle') return output === 'handle'
  if (typeof output !== 'object' || !('arrayObject' in output)) return false
  return Object.entries(input.arrayObject).every(([k, v]) => v !== 'handle' || output.arrayObject[k] === 'handle')
}

function shapeCompatible(output: LeafShape, input: LeafShape): boolean {
  if (output === 'unknown' || input === 'unknown') return true
  if (typeof output === 'string' || typeof input === 'string') return output === input
  return Object.entries(input.object).every(([k, v]) => fieldCompatible(output.object[k], v))
}

function shapesEqual(a: LeafShape, b: LeafShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A pipe step's declared shape. `leaf` reads straight from LEAF_SHAPES. `map`
 * derives its own boundary from its inner op's shape, one array level up
 * (issue #145): a `handle` inner input/output means the map as a whole is
 * `handle[]` on that side, since `unzip`'s `handle[]` output is the one
 * representable array shape this scheme has. Anything else the inner op's
 * shape resolves to (including 'unknown', or 'handle[]' which would need a
 * two-level array this scheme can't represent) makes the map's own boundary
 * 'unknown' too, rather than guessing. `mapField` derives its boundary the
 * same way, one level narrower: its inner op's shape becomes the *element
 * field*'s shape (only representable when the inner op's side is a bare
 * `handle` -- anything else collapses to 'unknown', same rule as an
 * `arrayObject` field elsewhere in this scheme), nested under the array
 * field's own name (`arrayField` on the input side, `renameTo ?? arrayField`
 * on the output side, since that's the one field name `mapField` actually
 * changes). A nested `pipe`/`sink` step composing multiple leaves has no
 * single input/output shape without walking further than a single
 * adjacent-step comparison needs to, so those still read as 'unknown' on
 * both sides. A `catch` step's own boundary is only representable when its
 * `try`/`catch` branches agree on a shape (shapesEqual) -- since either
 * branch could run at runtime, a mismatched pair collapses to 'unknown'
 * rather than guessing which branch a downstream step should be checked
 * against, same permissive fallback as an unrepresentable map/mapField case.
 */
function stepShape(s: OpSpec, side: 'input' | 'output'): LeafShape {
  if (!s || typeof s !== 'object') return 'unknown'
  if (s.tag === 'leaf') return LEAF_SHAPES[s.name]?.[side] ?? 'unknown'
  if (s.tag === 'map') return stepShape(s.op, side) === 'handle' ? 'handle[]' : 'unknown'
  if (s.tag === 'mapField') {
    const field: LeafFieldShape = stepShape(s.op, side) === 'handle' ? 'handle' : 'unknown'
    const arrayField = side === 'output' ? (s.renameTo ?? s.arrayField) : s.arrayField
    return { object: { [arrayField]: { arrayObject: { [s.elementField]: field } } } }
  }
  if (s.tag === 'catch') {
    const tryShape = stepShape(s.try, side); const catchShape = stepShape(s.catch, side)
    return shapesEqual(tryShape, catchShape) ? tryShape : 'unknown'
  }
  return 'unknown'
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
 * only a name. Supports `leaf`/`pipe`/`map`/`mapField`/`sink`: a `sink` spec
 * only carries target *names*, resolved against Caps.sinks at run time
 * (runInline's `case 'sink'`) the same way it already works for an in-process
 * caller -- see SINK_REGISTRY (./sinks.ts) and OpRunOpts.sinks
 * (../adapters/op-run.ts) for where those names come from. `mapField` (#168)
 * runs its inner op over one named field of each element of a named array
 * field, reattaching the untouched rest of each element and optionally
 * renaming the array field itself -- e.g. bridging unpack's `entries` into
 * pack's `files` while transforming each entry's `handle` in between, which
 * `map` alone can't do since it only replaces a whole array element, never
 * reshapes/renames the array's own field. `reconcile` only needs
 * `caps.store` (already supplied by every adapter call, see runInline's
 * `case 'reconcile'`), so it's expressible directly as an OpSpec variant.
 * `ask` is a straight pass-through to the `ask()` combinator -- `runInline`
 * already degrades gracefully with no `Ask` capability supplied (throws on
 * `onTimeout: 'fail'`, proceeds with the piped value on `'proceed'`), so no
 * extra validation is needed here beyond the tagged-union shape check. `catch`
 * (#183) runs its `try` branch and, on any thrown error
 * (retries exhausted, `CircuitOpenError`, `AskTimeoutError`, or a plain leaf
 * throw), re-runs its `catch` branch against the *original* input instead of
 * aborting the whole pipe -- e.g. "try the primary `sink`, fall back to a
 * secondary one".
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
 * and failing there -- sometimes silently, per #143. A `leaf` step's shape
 * comes straight from LEAF_SHAPES; a `map` step's own boundary is derived
 * from its inner op's shape, one array level up (#145); a nested `pipe`/
 * `sink` step still reads as 'unknown' (permissively compatible with
 * anything) since it has no single input/output shape (see stepShape's doc).
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
    case 'mapField': {
      if (!spec.op) throw new Error('mapField spec requires an `op`')
      const isBadFieldName = (f: unknown) => typeof f !== 'string' || !f || f === '__proto__' || f === 'constructor' || f === 'prototype'
      if (isBadFieldName(spec.arrayField)) {
        throw new Error('mapField spec\'s `arrayField` must be a non-empty string (not `__proto__`/`constructor`/`prototype`)')
      }
      if (isBadFieldName(spec.elementField)) {
        throw new Error('mapField spec\'s `elementField` must be a non-empty string (not `__proto__`/`constructor`/`prototype`)')
      }
      if (spec.renameTo !== undefined && isBadFieldName(spec.renameTo)) {
        throw new Error('mapField spec\'s `renameTo`, if present, must be a non-empty string (not `__proto__`/`constructor`/`prototype`)')
      }
      if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > MAX_MAP_CONCURRENCY) {
        throw new Error(`mapField spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}`)
      }
      return mapField(spec.arrayField, spec.elementField, buildOpNode(spec.op, leaves), { concurrency: fixed(spec.concurrency), renameTo: spec.renameTo })
    }
    case 'sink': {
      if (!Array.isArray(spec.targets) || !spec.targets.length || !spec.targets.every((t) => typeof t === 'string' && t)) {
        throw new Error('sink spec requires a non-empty `targets` array of non-empty strings')
      }
      return sink.fanout(...spec.targets)
    }
    case 'reconcile': {
      const o = spec.opts
      if (!o || typeof o !== 'object' || !RECONCILE_MODES.includes(o.mode)) {
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
    case 'catch': {
      if (!spec.try) throw new Error('catch spec requires a `try`')
      if (!spec.catch) throw new Error('catch spec requires a `catch`')
      return catchOp(buildOpNode(spec.try, leaves), buildOpNode(spec.catch, leaves))
    }
    case 'ask': {
      if (typeof spec.prompt !== 'string' || !spec.prompt) throw new Error('ask spec requires a non-empty `prompt`')
      if (typeof spec.timeout !== 'string' || !spec.timeout) throw new Error('ask spec requires a non-empty `timeout`')
      if (spec.onTimeout !== 'proceed' && spec.onTimeout !== 'fail') throw new Error('ask spec\'s `onTimeout` must be "proceed" or "fail"')
      return ask(spec.prompt, { timeout: spec.timeout, onTimeout: spec.onTimeout })
    }
    default:
      throw new Error(`unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: leaf, pipe, map, mapField, sink, reconcile, catch, ask)`)
  }
}
