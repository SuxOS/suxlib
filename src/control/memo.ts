import { canonicalize } from './retry.js'

// Handle's `producedAt` (src/effects/types.ts) is a real-clock stamp, not
// part of content identity -- a Handle surviving a reconcile's
// lastWriteWins keeps its winning producedAt, so leaving it in would make
// memoKey differ run to run for byte-identical content. Strip any
// `producedAt` field before canonicalizing so memoization keys strictly off
// content (r2Key/sha256/type/size etc), never off when it was produced.
function stripProducedAt(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripProducedAt)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.keys(o).reduce<Record<string, unknown>>((acc, k) => {
      if (k !== 'producedAt') acc[k] = stripProducedAt(o[k])
      return acc
    }, {})
  }
  return v
}

/**
 * Deterministic cache key for memoizing a leaf's *output* across separate
 * calls/runs -- leaf name plus the fully canonicalized `input` (a LeafFn's
 * single `input` param already carries both its Handle arg(s), whose sha256
 * is content-addressed, and any params, e.g. ShrinkInput's quality opts), so
 * identical inputs always hash identically. Distinct from retry.ts's
 * idempotencyKey, which dedupes retry *attempts* within one runGoverned call
 * (and is handed to the effect fn itself) rather than caching a result across
 * calls -- the `memo:` prefix keeps the two hash spaces from ever colliding
 * even though both reuse the same canonicalize().
 */
export async function memoKey(name: string, input: unknown): Promise<string> {
  const stable = JSON.stringify(canonicalize(stripProducedAt(input)))
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`memo:${name}:${stable}`))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
