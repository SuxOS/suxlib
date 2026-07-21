import type { Op, LeafFn, LeafOpts, Concurrency, CondPredicate } from './types.js'
import type { ReconcileOpts, FieldPolicy } from './reconcile.js'
import { op, pipe, map, mapField, sink, reconcile, catchOp, ask, cond, parallel } from './combinators.js'
import { resolveLeaf, mergeLeaves, LEAF_SHAPES, type LeafShape, type LeafFieldShape } from './registry.js'
import { fixed, aimd } from '../control/aimd.js'

export type OpSpecLeafOpts = { retries?: number; heavy?: boolean; memo?: boolean; kind?: 'pure' | 'effect' }
export type OpSpecSinkOpts = { retries?: number; heavy?: boolean; memo?: boolean }
// Mirrors src/op/types.ts's SinkFanoutTarget -- a bare name falls back to the
// sink spec's own `opts`, a `{ name, opts }` pair overrides per-field (#251).
export type OpSpecSinkTarget = string | { name: string; opts?: OpSpecSinkOpts }
// A plain number is shorthand for `{ kind: 'fixed', n }` (the only shape this
// field supported before #195) -- an object form mirrors governor.ts's own
// ConcurrencySpec discriminated union so a JSON spec can request adaptive
// backpressure (aimd) the same way an in-process caller building an Op tree
// by hand already could.
export type OpSpecConcurrency = number | { kind: 'aimd'; start?: number; min?: number; max?: number }
export type OpSpec =
  | { tag: 'leaf'; name: string; opts?: OpSpecLeafOpts; params?: Record<string, unknown> }
  | { tag: 'pipe'; steps: OpSpec[] }
  | { tag: 'map'; op: OpSpec; concurrency: OpSpecConcurrency }
  | { tag: 'mapField'; arrayField: string; elementField: string; op: OpSpec; concurrency: OpSpecConcurrency; renameTo?: string }
  | { tag: 'sink'; targets: OpSpecSinkTarget[]; opts?: OpSpecSinkOpts }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'catch'; try: OpSpec; catch: OpSpec }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
  | { tag: 'cond'; cases: { when: CondPredicate; then: OpSpec }[]; default?: OpSpec }
  | { tag: 'parallel'; ops: OpSpec[] }

// Exported (not module-private) so mcp.ts's opSpecSchema and op/introspect.ts's
// describePipelineSchema derive their field-policy/reconcile-mode enums from
// this one array instead of hand-duplicating the literal strings -- the
// concrete drift CLAUDE.md's OpSpec-validation footgun note warns about (#187).
export const FIELD_POLICIES = ['last-write-wins', 'union', 'keep-first'] as const satisfies readonly FieldPolicy[]
export const RECONCILE_MODES = ['faithful-union', 'last-write-wins', 'field-merge'] as const satisfies readonly ReconcileOpts['mode'][]

// Same reasoning: derive any hand-written list of OpSpec tags (mcp.ts's
// run_pipeline tool description, README's tag union prose) from this one
// array instead of re-enumerating the tag literals, which drifted twice
// already (#166, #158) before drifting a third time for reconcile/ask (#213).
export const OP_SPEC_TAGS = ['leaf', 'pipe', 'map', 'mapField', 'sink', 'reconcile', 'catch', 'ask', 'cond', 'parallel'] as const satisfies readonly OpSpec['tag'][]

// Retries/concurrency caps for adapter-triggered runs: generous enough for a
// real multi-step job, tight enough that a bad spec can't turn one request
// into an unbounded retry storm or a huge fan-out.
export const MAX_LEAF_RETRIES = 5
export const MAX_MAP_CONCURRENCY = 32
// sink.fanout runs every target fully concurrently (Promise.allSettled, no
// limiter, unlike map/mapField's MAX_MAP_CONCURRENCY-capped `fixed()`), so a
// caller-supplied `targets` array needs its own width cap for the same reason
// (#307) -- reachable from the unauthenticated-by-default POST /op/run.
export const MAX_SINK_TARGETS = 32
// buildOp/validateOpSpec/planOpSpec all eagerly map/forEach/recurse over every
// cond case at build time (regardless of how many actually run), same
// unbounded-build-cost DoS class #307 fixed for sink fanout -- reachable from
// the unauthenticated-by-default POST /op/run (#422).
export const MAX_COND_CASES = 32
// parallel runs every branch fully concurrently (Promise.allSettled, no
// limiter, same shape as sink.fanout), so a caller-supplied `ops` array needs
// the same width cap for the same reason (#289).
export const MAX_PARALLEL_BRANCHES = 32

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
 * against, same permissive fallback as an unrepresentable map/mapField case. A
 * `cond` node's own boundary follows the identical rule one level wider: only
 * representable when every case's `then` (and `default`, if present) agree on
 * a shape, since any one of them could run at runtime. `parallel`'s output
 * boundary mirrors `map`'s one-array-level-up rule, but across its fixed
 * `ops` branches instead of a runtime-variable array: representable as
 * `handle[]` only when every branch's own output is a bare `handle` (the one
 * array shape this scheme can represent), 'unknown' otherwise. Its *input*
 * side always reads 'unknown' -- unlike cond/catch, every branch receives the
 * *same* input concurrently, so "which branch's declared input shape should
 * a downstream check use" has no single right answer the way "the branch
 * that actually ran" does for cond/catch; picking one branch's shape would
 * be an arbitrary, possibly-wrong requirement on the step upstream of it.
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
    if (!Array.isArray(s.cases) || !s.cases.length) return 'unknown'
    const shapes = s.cases.map((c) => stepShape(c.then, side))
    if (s.default) shapes.push(stepShape(s.default, side))
    return shapes.every((sh) => shapesEqual(sh, shapes[0])) ? shapes[0] : 'unknown'
  }
  if (s.tag === 'parallel') {
    if (side === 'input') return 'unknown'
    if (!Array.isArray(s.ops) || !s.ops.length) return 'unknown'
    return s.ops.every((o) => stepShape(o, 'output') === 'handle') ? 'handle[]' : 'unknown'
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
 * caller-supplied spec JSON they do. Callers never reach this merge target
 * for a bare-`handle` leaf (buildOpNode's 'leaf' case rejects `params` before
 * building the pipe) -- otherwise this would happily overwrite a Handle's own
 * `r2Key`/`sha256` identity fields, letting a caller point a leaf at an
 * arbitrary Store entry it never legitimately produced or received (#172).
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
 * carries target *names*, resolved against Caps.sinks at run time
 * (runInline's `case 'sink'`) the same way it already works for an in-process
 * caller -- see SINK_REGISTRY (./sinks.ts) and OpRunOpts.sinks
 * (../adapters/op-run.ts) for where those names come from. A `sink` spec's
 * optional `opts` (retries/heavy/memo, #247) threads each target's write
 * through runGoverned exactly like an 'effect' leaf's `fn`, gated by
 * `caps.governors["sink:<target>"]` -- a `sink:` prefix keeps a sink
 * target's governor entry from colliding with a same-named leaf's own. `mapField` (#168)
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

export type OpSpecError = { path: string; message: string }

const isBadFieldName = (f: unknown): boolean => typeof f !== 'string' || !f || f === '__proto__' || f === 'constructor' || f === 'prototype'

const isInMapConcurrencyRange = (n: unknown): boolean => n === undefined || (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_MAP_CONCURRENCY)

// A map/mapField `concurrency` field is either a plain number (fixed()
// shorthand, range-checked exactly as before #195) or an `{ kind: 'aimd', ... }`
// spec mirroring governor.ts's ConcurrencySpec -- mirrored by buildOpNode's
// map/mapField cases below, same one-source-of-truth tradeoff isValidSinkTarget
// above already accepts. Returns an error message, or undefined if valid.
function concurrencySpecError(tagLabel: string, c: unknown): string | undefined {
  if (typeof c === 'number') {
    if (!Number.isInteger(c) || c < 1 || c > MAX_MAP_CONCURRENCY) {
      return `${tagLabel} spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}, or an \`{ kind: 'aimd', start?, min?, max? }\` spec`
    }
    return undefined
  }
  if (!c || typeof c !== 'object' || Array.isArray(c) || (c as { kind?: unknown }).kind !== 'aimd') {
    return `${tagLabel} spec's \`concurrency\` must be an integer between 1 and ${MAX_MAP_CONCURRENCY}, or an \`{ kind: 'aimd', start?, min?, max? }\` spec`
  }
  const { start, min, max } = c as { start?: unknown; min?: unknown; max?: unknown }
  if (!isInMapConcurrencyRange(start) || !isInMapConcurrencyRange(min) || !isInMapConcurrencyRange(max)) {
    return `${tagLabel} spec's \`concurrency\` aimd \`start\`/\`min\`/\`max\`, if present, must each be an integer between 1 and ${MAX_MAP_CONCURRENCY}`
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    return `${tagLabel} spec's \`concurrency\` aimd \`min\` cannot exceed \`max\``
  }
  return undefined
}

function buildConcurrency(c: OpSpecConcurrency): Concurrency {
  return typeof c === 'number' ? fixed(c) : aimd({ start: c.start, min: c.min, max: c.max })
}

// A sink target is either a bare non-empty name, or a `{ name, opts? }` pair
// whose own opts.retries (if present) is range-checked the same way the
// fanout-level opts.retries already is (#251) -- mirrored by buildOpNode's
// sink case below, same one-source-of-truth tradeoff this file's other
// buildOp/validateOpSpec pairs already accept (see collectSpecErrors's doc).
const isValidSinkTarget = (t: unknown): boolean => {
  if (typeof t === 'string') return !!t
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false
  const o = t as { name?: unknown; opts?: unknown }
  if (typeof o.name !== 'string' || !o.name) return false
  if (o.opts === undefined) return true
  if (typeof o.opts !== 'object' || o.opts === null || Array.isArray(o.opts)) return false
  const targetOpts = o.opts as OpSpecSinkOpts
  const r = targetOpts.retries
  if (r !== undefined && !(Number.isInteger(r) && r >= 0 && r <= MAX_LEAF_RETRIES)) return false
  if (targetOpts.heavy !== undefined && typeof targetOpts.heavy !== 'boolean') return false
  if (targetOpts.memo !== undefined && typeof targetOpts.memo !== 'boolean') return false
  return true
}

const isCondPrimitive = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

// A cond case's `when` predicate is either `{ field?, equals }` or `{ field?, in }` --
// exactly one of the two, never both/neither -- checked against a JSON scalar
// resolved off the piped value (never eval'd code, per #196's own framing).
// `field`, when present, is validated the same way mapField's arrayField/elementField
// are (isBadFieldName): reading `__proto__`/`constructor`/`prototype` off an object
// isn't a write-side pollution vector, but it's not a meaningful field lookup either.
const isValidCondPredicate = (p: unknown): boolean => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false
  const o = p as { field?: unknown; equals?: unknown; in?: unknown }
  if (o.field !== undefined && isBadFieldName(o.field)) return false
  const hasEquals = 'equals' in o; const hasIn = 'in' in o
  if (hasEquals === hasIn) return false
  if (hasEquals) return isCondPrimitive(o.equals)
  return Array.isArray(o.in) && o.in.every(isCondPrimitive)
}

/**
 * Validates a caller-supplied OpSpec against the same rules buildOp enforces
 * (leaf existence, retries/concurrency ranges, ask/reconcile/mapField field
 * shapes, pipe-adjacency shape compatibility, ...) without throwing on the
 * first problem it finds -- it walks the whole tree and collects every
 * structural error into an array, so a caller composing a nontrivial spec
 * (especially an LLM, per introspect.ts's own framing) can fix every mistake
 * from one round-trip instead of resubmitting once per buildOp throw (#208).
 * Never builds the actual Op tree or touches caps.store/llm/sinks -- purely
 * structural, spec-shape checking, safe to call before any of those exist.
 *
 * Mirrors buildOpNode's per-tag checks one-for-one (same conditions, same
 * MAX_LEAF_RETRIES/MAX_MAP_CONCURRENCY caps), but keeps descending into a
 * node's children even after that node itself has an error, wherever the
 * child spec is still reachable -- e.g. a bad `retries` on a leaf doesn't
 * stop a `pipe` from also checking that leaf's shape-adjacency against its
 * neighbor. There's no single source of truth these two functions share
 * beyond the small predicates factored out below (isBadFieldName,
 * shapeCompatible, stepShape, MAX_LEAF_RETRIES/MAX_MAP_CONCURRENCY) --
 * a future change to buildOpNode's validation rules must be mirrored here
 * too, same tradeoff CLAUDE.md's LEAF_SHAPES/LEAF_REGISTRY sync note already
 * flags for a different table.
 */
export function validateOpSpec(spec: OpSpec, extraLeaves?: Record<string, LeafFn>): OpSpecError[] {
  const errors: OpSpecError[] = []
  collectSpecErrors(spec, mergeLeaves(extraLeaves), '$', errors)
  return errors
}

function collectSpecErrors(spec: OpSpec, leaves: Readonly<Record<string, LeafFn>>, path: string, errors: OpSpecError[]): void {
  if (!spec || typeof spec !== 'object') {
    errors.push({ path, message: 'op spec must be an object' })
    return
  }
  switch (spec.tag) {
    case 'leaf': {
      if (typeof spec.name !== 'string' || !spec.name) {
        errors.push({ path, message: 'leaf spec requires a `name`' })
      } else {
        try {
          resolveLeaf(spec.name, leaves)
        } catch (e) {
          errors.push({ path, message: (e as Error).message })
        }
      }
      const o = spec.opts ?? {}
      if (o.retries !== undefined && (!Number.isInteger(o.retries) || o.retries < 0 || o.retries > MAX_LEAF_RETRIES)) {
        errors.push({ path, message: `leaf "${spec.name}": \`retries\` must be an integer between 0 and ${MAX_LEAF_RETRIES}` })
      }
      if (o.kind !== undefined && o.kind !== 'pure' && o.kind !== 'effect') {
        errors.push({ path, message: `leaf "${spec.name}": \`opts.kind\` must be "pure" or "effect"` })
      }
      if (o.heavy !== undefined && typeof o.heavy !== 'boolean') {
        errors.push({ path, message: `leaf "${spec.name}": \`opts.heavy\` must be a boolean` })
      }
      if (o.memo !== undefined && typeof o.memo !== 'boolean') {
        errors.push({ path, message: `leaf "${spec.name}": \`opts.memo\` must be a boolean` })
      }
      if (spec.params !== undefined && (typeof spec.params !== 'object' || spec.params === null || Array.isArray(spec.params))) {
        errors.push({ path, message: `leaf "${spec.name}": \`params\` must be an object` })
      } else if (spec.params !== undefined) {
        const shapeEntry = LEAF_SHAPES[spec.name]
        if (!shapeEntry) {
          errors.push({ path, message: `leaf "${spec.name}": \`params\` cannot be used on a leaf with no declared LEAF_SHAPES entry -- a host-registered extraLeaves leaf's undeclared shape defaults to denying \`params\` since it might take a bare Handle input, the same Store-read bypass #172 closed for built-ins (#174)` })
        } else if (shapeEntry.input === 'handle' || shapeEntry.input === 'handle[]') {
          errors.push({ path, message: `leaf "${spec.name}": \`params\` cannot be used on a bare-Handle input -- merging onto a Handle's own fields (r2Key/sha256/...) would let a caller overwrite its identity/location and read arbitrary Store entries (#172)` })
        }
      }
      return
    }
    case 'pipe': {
      if (!Array.isArray(spec.steps) || !spec.steps.length) {
        errors.push({ path, message: 'pipe spec requires a non-empty `steps` array' })
        return
      }
      spec.steps.forEach((s, i) => collectSpecErrors(s, leaves, `${path}.steps[${i}]`, errors))
      for (let i = 0; i + 1 < spec.steps.length; i++) {
        const prev = spec.steps[i]; const next = spec.steps[i + 1]
        const output = stepShape(prev, 'output'); const input = stepShape(next, 'input')
        if (!shapeCompatible(output, input)) {
          errors.push({
            path: `${path}.steps[${i + 1}]`,
            message: `pipe step ${i + 1} ("${stepLabel(next)}") expects ${shapeLabel(input)} input, but step ${i} ` +
              `("${stepLabel(prev)}") produces ${shapeLabel(output)}`,
          })
        }
      }
      return
    }
    case 'map': {
      if (!spec.op) errors.push({ path, message: 'map spec requires an `op`' })
      else collectSpecErrors(spec.op, leaves, `${path}.op`, errors)
      const concurrencyErr = concurrencySpecError('map', spec.concurrency)
      if (concurrencyErr) errors.push({ path, message: concurrencyErr })
      return
    }
    case 'mapField': {
      if (isBadFieldName(spec.arrayField)) {
        errors.push({ path, message: 'mapField spec\'s `arrayField` must be a non-empty string (not `__proto__`/`constructor`/`prototype`)' })
      }
      if (isBadFieldName(spec.elementField)) {
        errors.push({ path, message: 'mapField spec\'s `elementField` must be a non-empty string (not `__proto__`/`constructor`/`prototype`)' })
      }
      if (spec.renameTo !== undefined && isBadFieldName(spec.renameTo)) {
        errors.push({ path, message: 'mapField spec\'s `renameTo`, if present, must be a non-empty string (not `__proto__`/`constructor`/`prototype`)' })
      }
      if (!spec.op) errors.push({ path, message: 'mapField spec requires an `op`' })
      else collectSpecErrors(spec.op, leaves, `${path}.op`, errors)
      const concurrencyErr = concurrencySpecError('mapField', spec.concurrency)
      if (concurrencyErr) errors.push({ path, message: concurrencyErr })
      return
    }
    case 'sink': {
      if (!Array.isArray(spec.targets) || !spec.targets.length || !spec.targets.every(isValidSinkTarget)) {
        errors.push({ path, message: 'sink spec requires a non-empty `targets` array, each a non-empty string or `{ name, opts? }` with `opts.retries` (if present) an integer between 0 and ' + MAX_LEAF_RETRIES })
      } else if (spec.targets.length > MAX_SINK_TARGETS) {
        errors.push({ path, message: `sink spec's \`targets\` array cannot exceed ${MAX_SINK_TARGETS} entries (got ${spec.targets.length}) -- sink.fanout runs every target fully concurrently with no limiter` })
      }
      const so = spec.opts?.retries
      if (so !== undefined && (!Number.isInteger(so) || so < 0 || so > MAX_LEAF_RETRIES)) {
        errors.push({ path, message: `sink: \`opts.retries\` must be an integer between 0 and ${MAX_LEAF_RETRIES}` })
      }
      if (spec.opts?.heavy !== undefined && typeof spec.opts.heavy !== 'boolean') {
        errors.push({ path, message: 'sink: `opts.heavy` must be a boolean' })
      }
      if (spec.opts?.memo !== undefined && typeof spec.opts.memo !== 'boolean') {
        errors.push({ path, message: 'sink: `opts.memo` must be a boolean' })
      }
      return
    }
    case 'reconcile': {
      const o = spec.opts
      if (!o || typeof o !== 'object' || !RECONCILE_MODES.includes(o.mode)) {
        errors.push({ path, message: `reconcile spec's \`opts.mode\` must be one of: ${RECONCILE_MODES.join(', ')}` })
      }
      if (o && typeof o === 'object' && o.mode === 'field-merge') {
        if (o.defaultPolicy !== undefined && !FIELD_POLICIES.includes(o.defaultPolicy)) {
          errors.push({ path, message: `reconcile spec's \`opts.defaultPolicy\` must be one of: ${FIELD_POLICIES.join(', ')}` })
        }
        if (o.policy !== undefined) {
          if (typeof o.policy !== 'object' || o.policy === null || Array.isArray(o.policy)) {
            errors.push({ path, message: 'reconcile spec\'s `opts.policy` must be an object' })
          } else {
            for (const [k, v] of Object.entries(o.policy)) {
              if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
              if (!FIELD_POLICIES.includes(v as FieldPolicy)) {
                errors.push({ path, message: `reconcile spec's \`opts.policy["${k}"]\` must be one of: ${FIELD_POLICIES.join(', ')}` })
              }
            }
          }
        }
      }
      return
    }
    case 'catch': {
      if (!spec.try) errors.push({ path, message: 'catch spec requires a `try`' })
      else collectSpecErrors(spec.try, leaves, `${path}.try`, errors)
      if (!spec.catch) errors.push({ path, message: 'catch spec requires a `catch`' })
      else collectSpecErrors(spec.catch, leaves, `${path}.catch`, errors)
      return
    }
    case 'ask': {
      if (typeof spec.prompt !== 'string' || !spec.prompt) errors.push({ path, message: 'ask spec requires a non-empty `prompt`' })
      if (typeof spec.timeout !== 'string' || !spec.timeout) errors.push({ path, message: 'ask spec requires a non-empty `timeout`' })
      if (spec.onTimeout !== 'proceed' && spec.onTimeout !== 'fail') errors.push({ path, message: 'ask spec\'s `onTimeout` must be "proceed" or "fail"' })
      return
    }
    case 'cond': {
      if (!Array.isArray(spec.cases) || !spec.cases.length) {
        errors.push({ path, message: 'cond spec requires a non-empty `cases` array' })
      } else if (spec.cases.length > MAX_COND_CASES) {
        errors.push({ path, message: `cond spec's \`cases\` array cannot exceed ${MAX_COND_CASES} entries (got ${spec.cases.length})` })
      } else {
        spec.cases.forEach((c, i) => {
          if (!c || typeof c !== 'object' || !isValidCondPredicate(c.when)) {
            errors.push({ path: `${path}.cases[${i}]`, message: 'cond case\'s `when` must be `{ field?, equals }` or `{ field?, in }` (exactly one of `equals`/`in`, each a JSON scalar or array of scalars, `field` not `__proto__`/`constructor`/`prototype`)' })
          }
          if (!c || !c.then) errors.push({ path: `${path}.cases[${i}]`, message: 'cond case requires a `then`' })
          else collectSpecErrors(c.then, leaves, `${path}.cases[${i}].then`, errors)
        })
      }
      if (spec.default !== undefined) collectSpecErrors(spec.default, leaves, `${path}.default`, errors)
      return
    }
    case 'parallel': {
      if (!Array.isArray(spec.ops) || !spec.ops.length) {
        errors.push({ path, message: 'parallel spec requires a non-empty `ops` array' })
      } else if (spec.ops.length > MAX_PARALLEL_BRANCHES) {
        errors.push({ path, message: `parallel spec's \`ops\` array cannot exceed ${MAX_PARALLEL_BRANCHES} entries (got ${spec.ops.length})` })
      } else {
        spec.ops.forEach((o, i) => collectSpecErrors(o, leaves, `${path}.ops[${i}]`, errors))
      }
      return
    }
    default:
      errors.push({ path, message: `unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: ${OP_SPEC_TAGS.join(', ')})` })
  }
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
      if (o.kind !== undefined && o.kind !== 'pure' && o.kind !== 'effect') {
        throw new Error(`leaf "${spec.name}": \`opts.kind\` must be "pure" or "effect"`)
      }
      if (o.heavy !== undefined && typeof o.heavy !== 'boolean') {
        throw new Error(`leaf "${spec.name}": \`opts.heavy\` must be a boolean`)
      }
      if (o.memo !== undefined && typeof o.memo !== 'boolean') {
        throw new Error(`leaf "${spec.name}": \`opts.memo\` must be a boolean`)
      }
      if (spec.params !== undefined && (typeof spec.params !== 'object' || spec.params === null || Array.isArray(spec.params))) {
        throw new Error(`leaf "${spec.name}": \`params\` must be an object`)
      }
      if (spec.params !== undefined) {
        const shapeEntry = LEAF_SHAPES[spec.name]
        if (!shapeEntry) {
          throw new Error(`leaf "${spec.name}": \`params\` cannot be used on a leaf with no declared LEAF_SHAPES entry -- a host-registered extraLeaves leaf's undeclared shape defaults to denying \`params\` since it might take a bare Handle input, the same Store-read bypass #172 closed for built-ins (#174)`)
        }
        if (shapeEntry.input === 'handle' || shapeEntry.input === 'handle[]') {
          throw new Error(`leaf "${spec.name}": \`params\` cannot be used on a bare-Handle input -- merging onto a Handle's own fields (r2Key/sha256/...) would let a caller overwrite its identity/location and read arbitrary Store entries (#172)`)
        }
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
      const concurrencyErr = concurrencySpecError('map', spec.concurrency)
      if (concurrencyErr) throw new Error(concurrencyErr)
      return map(buildOpNode(spec.op, leaves), { concurrency: buildConcurrency(spec.concurrency) })
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
      const concurrencyErr = concurrencySpecError('mapField', spec.concurrency)
      if (concurrencyErr) throw new Error(concurrencyErr)
      return mapField(spec.arrayField, spec.elementField, buildOpNode(spec.op, leaves), { concurrency: buildConcurrency(spec.concurrency), renameTo: spec.renameTo })
    }
    case 'sink': {
      if (!Array.isArray(spec.targets) || !spec.targets.length || !spec.targets.every(isValidSinkTarget)) {
        throw new Error('sink spec requires a non-empty `targets` array, each a non-empty string or `{ name, opts? }` with `opts.retries` (if present) an integer between 0 and ' + MAX_LEAF_RETRIES)
      }
      if (spec.targets.length > MAX_SINK_TARGETS) {
        throw new Error(`sink spec's \`targets\` array cannot exceed ${MAX_SINK_TARGETS} entries (got ${spec.targets.length}) -- sink.fanout runs every target fully concurrently with no limiter`)
      }
      const so = spec.opts?.retries
      if (so !== undefined && (!Number.isInteger(so) || so < 0 || so > MAX_LEAF_RETRIES)) {
        throw new Error(`sink: \`opts.retries\` must be an integer between 0 and ${MAX_LEAF_RETRIES}`)
      }
      if (spec.opts?.heavy !== undefined && typeof spec.opts.heavy !== 'boolean') {
        throw new Error('sink: `opts.heavy` must be a boolean')
      }
      if (spec.opts?.memo !== undefined && typeof spec.opts.memo !== 'boolean') {
        throw new Error('sink: `opts.memo` must be a boolean')
      }
      return sink.fanout(spec.targets, spec.opts)
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
    case 'cond': {
      if (!Array.isArray(spec.cases) || !spec.cases.length) throw new Error('cond spec requires a non-empty `cases` array')
      if (spec.cases.length > MAX_COND_CASES) {
        throw new Error(`cond spec's \`cases\` array cannot exceed ${MAX_COND_CASES} entries (got ${spec.cases.length})`)
      }
      const cases = spec.cases.map((c) => {
        if (!c || !isValidCondPredicate(c.when)) {
          throw new Error('cond case\'s `when` must be `{ field?, equals }` or `{ field?, in }` (exactly one of `equals`/`in`, each a JSON scalar or array of scalars, `field` not `__proto__`/`constructor`/`prototype`)')
        }
        if (!c.then) throw new Error('cond case requires a `then`')
        return { when: c.when, then: buildOpNode(c.then, leaves) }
      })
      return cond(cases, spec.default ? buildOpNode(spec.default, leaves) : undefined)
    }
    case 'parallel': {
      if (!Array.isArray(spec.ops) || !spec.ops.length) throw new Error('parallel spec requires a non-empty `ops` array')
      if (spec.ops.length > MAX_PARALLEL_BRANCHES) {
        throw new Error(`parallel spec's \`ops\` array cannot exceed ${MAX_PARALLEL_BRANCHES} entries (got ${spec.ops.length})`)
      }
      return parallel(spec.ops.map((o) => buildOpNode(o, leaves)))
    }
    default:
      throw new Error(`unsupported op spec tag "${(spec as { tag?: unknown }).tag}" (allowed: ${OP_SPEC_TAGS.join(', ')})`)
  }
}
