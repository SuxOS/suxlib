import type { LeafFn } from './types.js'
import { pack, unpack, unzip } from '../domain/archive.js'
import { shrink, pageCount } from '../domain/pdf.js'
import { redact, scrub } from '../domain/sanitize.js'
import { convert } from '../domain/transform.js'
import { extract, summarize } from '../domain/text.js'
import { wrapHandle, unwrapHandle, stampLeaf } from './reshape.js'

/**
 * name -> LeafFn registry for every domain leaf already exposed as a
 * Handle-based op-engine leaf (CLAUDE.md's "leaf-naming convention"). An Op's
 * `leaf` node (src/op/types.ts) embeds a live `fn` reference, which is fine
 * for an in-process caller building a tree by hand, but not something it's
 * safe to accept from outside the process (an adapter request body, an MCP
 * tool call) -- this registry is what a JSON op spec (src/op/spec.ts)
 * resolves a leaf *name* against instead.
 */
// Object.create(null), not a {}/object-literal prototype chain: a plain
// object's LEAF_REGISTRY[name] lookup below would resolve `name`s like
// 'constructor'/'toString'/'hasOwnProperty' to the corresponding inherited
// Object.prototype/Function.prototype function instead of throwing "unknown
// leaf" -- and those names are reachable from an untrusted caller-supplied
// JSON op spec (src/op/spec.ts's buildOp), same class of bug CLAUDE.md
// documents for fieldMerge/parseXml/canonicalize/op-run.ts's hydrate.
export const LEAF_REGISTRY: Readonly<Record<string, LeafFn>> = Object.freeze(
  Object.assign(Object.create(null), { pack, unpack, unzip, shrink, pageCount, redact, scrub, convert, extract, summarize, wrapHandle, unwrapHandle, stamp: stampLeaf }),
)

/**
 * A leaf's declared input/output shape, coarse enough to cover every
 * LEAF_REGISTRY entry without guessing at field richness `buildOp` (./spec.ts)
 * has no real use for: a bare Handle, an array of Handles (unzip's only
 * output shape), an object whose fields are each a Handle, an array of
 * Handle-bearing objects (`arrayObject` -- pack's `files` input field and
 * unpack's `entries` output field, #161), or 'unknown' itself for anything
 * else this scheme can't represent. 'unknown' is the deliberately permissive
 * default on either side of a comparison (spec.ts's shapeCompatible) --
 * CLAUDE.md's "Leaf composability gotcha" scoping note says how much shape
 * richness is worth encoding needs its own design pass, so this only ever
 * blocks a *provably* mismatched Handle-shaped pipe step, never a
 * plausibly-fine one.
 */
export type LeafFieldShape = 'handle' | 'unknown' | { arrayObject: Record<string, 'handle' | 'unknown'> }
export type LeafShape = 'unknown' | 'handle' | 'handle[]' | { object: Record<string, LeafFieldShape> }

/**
 * Per-leaf declared shape, keyed by the same LEAF_REGISTRY name -- used by
 * buildOp's 'pipe' case (./spec.ts) to catch a build-time-detectable shape
 * mismatch between adjacent steps instead of letting it reach `runInline`
 * (silently, per #143/#132: an `undefined` flowing through `dehydrate` into
 * an HTTP 200 with an empty body). A name absent here (a host-registered
 * `extraLeaves` leaf, or any future built-in this table falls behind) reads
 * as 'unknown' on both sides via LEAF_SHAPES[name]?.[side] -- same permissive
 * default as an unrepresentable shape.
 */
export const LEAF_SHAPES: Readonly<Record<string, { input: LeafShape; output: LeafShape }>> = Object.freeze({
  pack: { input: { object: { format: 'unknown', files: { arrayObject: { name: 'unknown', handle: 'handle', mtime: 'unknown' } } } }, output: 'handle' },
  unpack: { input: { object: { format: 'unknown', handle: 'handle' } }, output: { object: { entries: { arrayObject: { name: 'unknown', handle: 'handle', mtime: 'unknown' } }, skipped: 'unknown' } } },
  unzip: { input: 'handle', output: 'handle[]' },
  shrink: { input: { object: { handle: 'handle' } }, output: { object: { handle: 'handle' } } },
  pageCount: { input: 'handle', output: 'unknown' },
  redact: { input: { object: { handle: 'handle' } }, output: { object: { handle: 'handle' } } },
  scrub: { input: 'handle', output: { object: { handle: 'handle' } } },
  convert: { input: { object: { handle: 'handle' } }, output: 'handle' },
  extract: { input: 'handle', output: 'handle' },
  summarize: { input: 'handle', output: { object: { summaryHandle: 'handle' } } },
  wrapHandle: { input: 'handle', output: { object: { handle: 'handle' } } },
  unwrapHandle: { input: { object: { handle: 'handle' } }, output: 'handle' },
  stamp: { input: 'handle', output: 'handle' },
})

/**
 * Merges host-supplied leaves onto LEAF_REGISTRY, same override order as
 * SINK_REGISTRY's host-overrides-built-in merge (src/adapters/op-run.ts's
 * `Object.assign(Object.create(null), SINK_REGISTRY, opts.sinks)`).
 * Object.create(null), not a {}/object-literal spread: merging a
 * null-prototype registry via spread (`{ ...LEAF_REGISTRY, ...extraLeaves }`)
 * silently produces an ordinary Object.prototype-based result (CLAUDE.md's
 * "Prototype-pollution-guard gotcha for any future Object.create(null)-based
 * registry"), which would undo the guard resolveLeaf's table lookup depends
 * on below. Callers building a JSON op-tree (src/op/spec.ts's buildOp) call
 * this once per run and thread the merged table through recursion, rather
 * than re-merging per leaf node.
 */
export function mergeLeaves(extraLeaves?: Record<string, LeafFn>): Readonly<Record<string, LeafFn>> {
  return extraLeaves ? Object.assign(Object.create(null), LEAF_REGISTRY, extraLeaves) : LEAF_REGISTRY
}

export function resolveLeaf(name: string, table: Readonly<Record<string, LeafFn>> = LEAF_REGISTRY): LeafFn {
  const fn = table[name]
  if (!fn) throw new Error(`unknown leaf "${name}" (registered: ${Object.keys(table).join(', ')})`)
  return fn
}
