import type { LeafFn } from './types.js'
import type { Handle } from '../effects/types.js'

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

// Throws rather than silently plucking `undefined` off a bare Handle (e.g.
// convert's output, which has no `.handle` field) -- see CLAUDE.md's "Leaf
// composability gotcha" for why that mis-chain is an easy mistake to make.
export const unwrapHandle: LeafFn = async (input) => {
  const handle = (input as { handle?: Handle } | undefined)?.handle
  if (!handle || typeof handle !== 'object' || typeof handle.r2Key !== 'string' || typeof handle.sha256 !== 'string') {
    throw new Error('unwrapHandle: input is not {handle: Handle}-shaped')
  }
  return handle
}
