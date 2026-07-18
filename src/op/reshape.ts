import type { LeafFn } from './types.js'
import type { Handle } from '../effects/types.js'
import { stamp } from '../handles/handle.js'

// Reshape leaves: every {handle, ...opts}-shaped leaf (pdf.ts's shrink,
// sanitize.ts's redact, transform.ts's convert) already agrees on the field
// name "handle", so a single fixed-field pair closes the input/output half of
// CLAUDE.md's "Leaf composability gotcha" for that whole family -- a caller
// composing a JSON op spec (src/op/spec.ts) can wrap a bare Handle (e.g. one
// element of unzip's Handle[] output) into that shape (relying on each
// leaf's own opts defaults) and unwrap a {handle, ...} result back to a bare
// Handle, without a host-side reshaping step. Leaves whose extra opts aren't
// optional (convert's `to`) still need those opts merged in some other way --
// these two only bridge the `handle` field itself.
export const wrapHandle: LeafFn = async (handle) => ({ handle: handle as Handle })

export const unwrapHandle: LeafFn = async (input) => (input as { handle: Handle }).handle

// Stamps a bare Handle with caps.clock's current time, so it satisfies
// reconcile.ts's lastWriteWins() (which requires every input Handle to carry
// producedAt) -- registered in LEAF_REGISTRY (as "stamp") so a JSON op spec
// can reach it without a host-side non-registered leaf. Named stampLeaf, not
// stamp, so index.ts's `export *` barrel doesn't collide with handle.ts's
// raw stamp(h, clock) helper this wraps -- same class of gotcha CLAUDE.md's
// "Leaf-naming convention" documents for domain pure fn vs. LeafFn wrapper
// pairs, just surfacing here across two different modules instead of one.
export const stampLeaf: LeafFn = async (handle, caps) => stamp(handle as Handle, caps.clock)
