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
