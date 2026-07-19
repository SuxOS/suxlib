import type { Op, LeafFn, LeafOpts, Concurrency } from './types.js'
import type { ReconcileOpts, FieldPolicy } from './reconcile.js'
import type { CondPredicate } from './predicate.js'
import { op, pipe, map, mapField, sink, reconcile, catchOp, ask, cond } from './combinators.js'
import { resolveLeaf, mergeLeaves, LEAF_SHAPES, type LeafShape, type LeafFieldShape } from './registry.js'
import { fixed, aimd } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
// A plain number is shorthand for `{ kind: 'fixed', n }`; the `aimd` variant
// mirrors governor.ts's ConcurrencySpec so a JSON-described map/mapField fan-out
// can opt into adaptive backpressure the same way an in-process caller already
// can by passing aimd() directly (#195).
export type OpSpecConcurrency = number | { kind: 'aimd'; start?: number; min?: number; max?: number }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts; params?: Record<string, unknown> }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: OpSpecConcurrency }
  | { tag: 'mapField'; arrayField: string; elementField: string; op: OpSpec; concurrency: OpSpecConcurrency; renameTo?: string }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'catch'; try: OpSpec; catch: OpSpec }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
  | { tag: 'cond'; branches: Array<{ when: CondPredicate; op: OpSpec }>; default?: OpSpec }

const FIELD_POLICIES: FieldPolicy[] = ['last-write-wins', 'union', 'keep-first']
const RECONCILE_MODES = ['faithful-union', 'last-write-wins', 'field-merge']
const PREDICATE_KINDS = ['eq', 'in', 'exists']

// Retries/concurrency caps for adapter-triggered runs: generous enough for a
// real multi-step job, tight enough that a bad spec can't turn one request
// into an unbounded retry storm or a huge fan-out.
const MAX_LEAF_RETRIES = 5
const MAX_MAP_CONCURRENCY = 32

/**
 * Builds the live `Concurrency` a map/mapField spec asks for: a plain integer
 * (existing shorthand) becomes `fixed(n)`; `{ kind: 'aimd', ... }` becomes an
 * adaptive `aimd()` bounded by the same MAX_MAP_CONCURRENCY cap other spec
 * fan-out uses, so a JSON pipeline can request backpressure that grows/shrinks
 * with success/failure instead of only ever a static pre-chosen cap (#195).
 */
function resolveConcurrency(c: OpSpecConcurrency, label: string): Concurrency {
  if (typeof c === 'number') {
    if (!Number.isInteger(c) || c < 1 || c > MAX_MAP_CONCURRENCY) {
      throw new Error(`${label} spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}`)
    }
    return fixed(c)
  }
  if (!c || typeof c !== 'object' || c.kind !== 'aimd') {
    throw new Error(`${label} spec's \`concurrency\` must be an integer, or an object shaped { kind: 'aimd', start?, min?, max? }`)
  }
  for (const [k, v] of Object.entries({ start: c.start, min: c.min, max: c.max })) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > MAX_MAP_CONCURRENCY)) {
      throw new Error(`${label} spec's \`concurrency.${k}\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}`)
    }
  }
  return aimd({ start: c.start, min: c.min, max: c.max })
}

/**
 * Validates a cond branch's `when` against CondPredicate's shape (src/op/predicate.ts)
 * -- `kind` picks the check, `field` names the top-level input field it reads, and
 * `in`'s `values` must be an array. `eq`'s `value` and `exists` need no further shape
 * check beyond `field` since they accept anything JSON-shaped.
 */
function validatePredicate(w: unknown, branchIndex: number): asserts w is CondPredicate {
  if (!w || typeof w !== 'object') throw new Error(`cond spec's branch ${branchIndex} \`when\` must be an object`)
  const p = w as Record<string, unknown>
  if (!PREDICATE_KINDS.includes(p.kind as string)) {
    throw new Error(`cond spec's branch ${branchIndex} \`when.kind\` must be one of: ${PREDICATE_KINDS.join(', ')}`)
  }
  if (typeof p.field !== 'string' || !p.field) {
    throw new Error(`cond spec's branch ${branchIndex} \`when.field\` must be a non-empty string`)
  }
  if (p.kind === 'in' && !Array.isArray(p.values)) {
    throw new Error(`cond spec's branch ${branchIndex} \`when.values\` must be an array (kind: "in")`)
  }
}

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
 * A `cond` step's own boundary follows the same rule one step further: only
 * representable when every branch's `op` (and `default`, if given) agree on
 * a shape -- any disagreement collapses to 'unknown', since at runtime only
 * whichever branch matches actually runs.
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
  if (s.tag === 'cond') {
    const shapes = s.branches.map((b) => stepShape(b.op, side)).concat(s.default ? [stepShape(s.default, side)] : [])
    return shapes.every((sh) => shapesEqual(sh, shapes[0])) ? shapes[0] : 'unknown'
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
 * secondary one". `cond` (#196) is `catch`'s success-path counterpart:
 * it runs the first branch whose declarative `when` predicate
 * (CondPredicate, ./predicate.ts -- field-equals/field-in/exists checks
 * only, never arbitrary code) matches the piped value, or `default` if none
 * match (and throws if neither matches and no `default` was given) --
 * letting a JSON pipeline route itself on the input's shape/content instead
 * of the caller pre-deciding which branch to send.
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
      return map(buildOpNode(spec.op, leaves), { concurrency: resolveConcurrency(spec.concurrency, 'map') })
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
      return mapField(spec.arrayField, spec.elementField, buildOpNode(spec.op, leaves), { concurrency: resolveConcurrency(spec.concurrency, 'mapField'), renameTo: spec.renameTo })
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
    case 'cond': {
      if (!Array.isArray(spec.branches) || !spec.branches.length) {
        throw new Error('cond spec requires a non-empty `branches` array')
      }
      const branches = spec.branches.map((b, i) => {
        if (!b || typeof b !== 'object') throw new Error(`cond spec's branch ${i} must be an object`)
        validatePredicate(b.when, i)
        if (!b.op) throw new Error(`cond spec's branch ${i} requires an \`op\``)
        return { when: b.when, op: buildOpNode(b.op, leaves) }
      })
      return cond(branches, spec.default ? buildOpNode(spec.default, leaves) : undefined)
    }
    default:
      throw new Error(`unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: leaf, pipe, map, mapField, sink, reconcile, catch, ask, cond)`)
  }
}
