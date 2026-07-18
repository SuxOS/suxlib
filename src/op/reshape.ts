import type { LeafFn } from './types.js'

// Pure registry-eligible leaves that bridge the field-shape mismatch between
// Handle-returning leaves (unzip: Handle -> Handle[]) and Handle-taking
// leaves that expect a bare value wrapped under `handle` (shrink/redact/
// convert's `{ handle, ...opts }` input shape) -- documented in CLAUDE.md's
// "leaf-naming convention" bullet. Without these, a spec that wants e.g.
// unzip -> map(shrink) -> map(pack) needs a host-side glue step between each
// mismatched pair; wrapHandle/unwrapHandle let the spec express that itself.
// Both take/return no other fields since the convention across every
// existing Handle-based leaf (pack/unpack/shrink/redact/convert) already
// keys the wrapped Handle as `handle`.

export const wrapHandle: LeafFn = async (input) => ({ handle: input })

export type UnwrapHandleInput = { handle: unknown }
export const unwrapHandle: LeafFn = async (input) => (input as UnwrapHandleInput).handle
