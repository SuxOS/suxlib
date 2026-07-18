import type { LeafFn } from './types.js'
import { pack, unpack, unzip } from '../domain/archive.js'
import { shrink } from '../domain/pdf.js'
import { redact, scrub } from '../domain/sanitize.js'
import { convert } from '../domain/transform.js'
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
  Object.assign(Object.create(null), { pack, unpack, unzip, shrink, redact, scrub, convert, wrapHandle, unwrapHandle, stamp: stampLeaf }),
)

export function resolveLeaf(name: string): LeafFn {
  const fn = LEAF_REGISTRY[name]
  if (!fn) throw new Error(`unknown leaf "${name}" (registered: ${Object.keys(LEAF_REGISTRY).join(', ')})`)
  return fn
}

/**
 * A lightweight, runtime-checkable description of a leaf's input/output
 * shape -- just enough to catch the "leaf composability gotcha" CLAUDE.md
 * documents (three separate patches: #118, #124, #132) without trying to
 * fully type every leaf's params. `'unknown'` means "don't check this" (used
 * for both non-Handle-shaped fields, e.g. pack's `format`, and for a shape
 * this scheme can't express, e.g. unpack's `entries` array) -- it always
 * matches, on either side of a comparison, so it degrades to "unvalidated"
 * rather than a false-positive mismatch.
 */
export type LeafShape = 'handle' | 'handle[]' | 'unknown' | { object: Record<string, 'handle' | 'unknown'> }

// One entry per LEAF_REGISTRY name, describing the shape buildOp's pipe
// validation (src/op/spec.ts) checks a step's declared input against its
// predecessor's declared output. Kept as a plain sibling map (not folded
// into LeafFn itself) since a LeafFn is just `(input, caps, key?) =>
// Promise<any>` -- there's nowhere on that signature to hang static shape
// metadata without changing every leaf's type.
export const LEAF_SHAPES: Readonly<Record<string, { input: LeafShape; output: LeafShape }>> = Object.freeze(
  Object.assign(Object.create(null), {
    pack: { input: { object: { format: 'unknown', files: 'unknown' } }, output: 'handle' },
    unpack: { input: { object: { format: 'unknown', handle: 'handle' } }, output: { object: { entries: 'unknown' } } },
    unzip: { input: 'handle', output: 'handle[]' },
    shrink: { input: { object: { handle: 'handle' } }, output: { object: { handle: 'handle' } } },
    redact: { input: { object: { handle: 'handle' } }, output: { object: { handle: 'handle' } } },
    scrub: { input: 'handle', output: { object: { handle: 'handle' } } },
    convert: { input: { object: { handle: 'handle' } }, output: 'handle' },
    wrapHandle: { input: 'handle', output: { object: { handle: 'handle' } } },
    unwrapHandle: { input: { object: { handle: 'handle' } }, output: 'handle' },
    stamp: { input: 'handle', output: 'handle' },
  } satisfies Record<string, { input: LeafShape; output: LeafShape }>),
)
