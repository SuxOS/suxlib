import type { LeafFn } from './types.js'
import { pack, unpack, unzip } from '../domain/archive.js'
import { shrink } from '../domain/pdf.js'
import { redact, scrub } from '../domain/sanitize.js'
import { convert } from '../domain/transform.js'
import { wrapHandle, unwrapHandle } from './reshape.js'

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
  Object.assign(Object.create(null), { pack, unpack, unzip, shrink, redact, scrub, convert, wrapHandle, unwrapHandle }),
)

export function resolveLeaf(name: string): LeafFn {
  const fn = LEAF_REGISTRY[name]
  if (!fn) throw new Error(`unknown leaf "${name}" (registered: ${Object.keys(LEAF_REGISTRY).join(', ')})`)
  return fn
}

/**
 * Coarse per-leaf input/output shape, keyed by the same name as LEAF_REGISTRY
 * -- src/op/spec.ts's buildOp walks these across a `pipe`'s consecutive steps
 * to catch a shape-incompatible chain (CLAUDE.md's "Leaf composability
 * gotcha") at build time instead of letting it reach `runInline`. Only
 * describes the "is this a bare Handle, a Handle array, or an object with a
 * `handle` field" question -- an object shape's non-`'handle'` fields (e.g.
 * convert's `to`/`from`, pack's `files`) are `'unknown'` rather than
 * recursively typed, since those are either supplied via a leaf spec's
 * `params` (never from the previous step's output) or aren't Handle-shaped at
 * all (pack's `files` is an array of `{name, handle, mtime?}`, not a bare
 * Handle) -- `'unknown'` is also the shape for pack/unpack's non-Handle-typed
 * side entirely, deliberately opting them out of the check rather than
 * guessing.
 */
export type LeafShape = 'handle' | 'handle[]' | { object: Record<string, 'handle' | 'unknown'> } | 'unknown'

export const LEAF_SHAPES: Readonly<Record<string, { input: LeafShape; output: LeafShape }>> = Object.freeze(
  Object.assign(Object.create(null), {
    pack: { input: { object: { format: 'unknown', files: 'unknown' } }, output: 'handle' },
    unpack: { input: { object: { format: 'unknown', handle: 'handle' } }, output: 'unknown' },
    unzip: { input: 'handle', output: 'handle[]' },
    shrink: { input: { object: { handle: 'handle' } }, output: { object: { handle: 'handle' } } },
    redact: { input: { object: { handle: 'handle', types: 'unknown' } }, output: { object: { handle: 'handle' } } },
    scrub: { input: 'handle', output: { object: { handle: 'handle' } } },
    convert: { input: { object: { handle: 'handle', from: 'unknown', to: 'unknown', delimiter: 'unknown' } }, output: 'handle' },
    wrapHandle: { input: 'handle', output: { object: { handle: 'handle' } } },
    unwrapHandle: { input: { object: { handle: 'handle' } }, output: 'handle' },
  } satisfies Record<string, { input: LeafShape; output: LeafShape }>),
)
