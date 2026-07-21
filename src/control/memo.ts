import { canonicalize } from './retry.js'

// Walks `input` the same shape canonicalize() does (arrays, then plain
// objects, recursing into each) but, before any hashing happens, drops the
// `producedAt` key from any Handle-shaped object encountered anywhere in the
// tree -- structurally identified by having both an `r2Key` and a `sha256`
// own-enumerable string key, not by importing the Handle type. `producedAt`
// is a real-clock timestamp (handles/handle.ts's stamp()) that a lastWriteWins
// reconcile still returns intact on its winning Handle, so leaving it in would
// make memoKey hash differently every run for byte-identical content. Runs as
// its own pass (with its own circular-reference guard, mirroring canonicalize's)
// rather than folding into canonicalize() itself, which idempotencyKey also
// uses and whose semantics are deliberately left untouched.
function stripProducedAt(v: unknown, stack: Set<object> = new Set()): unknown {
  if (v instanceof Date) return v
  if (Array.isArray(v)) {
    if (stack.has(v)) throw new TypeError('stripProducedAt: circular reference')
    stack.add(v)
    const result = v.map(x => stripProducedAt(x, stack))
    stack.delete(v)
    return result
  }
  if (v && typeof v === 'object') {
    if (stack.has(v)) throw new TypeError('stripProducedAt: circular reference')
    stack.add(v)
    const o = v as Record<string, unknown>
    const isHandleShaped = typeof o.r2Key === 'string' && typeof o.sha256 === 'string'
    const result: Record<string, unknown> = {}
    for (const k of Object.keys(o)) {
      if (isHandleShaped && k === 'producedAt') continue
      result[k] = stripProducedAt(o[k], stack)
    }
    stack.delete(v)
    return result
  }
  return v
}

/**
 * The pre-hash string memoKey() below digests -- factored out and exported
 * synchronously so runGoverned's singleflight in-flight map (#311,
 * src/control/governor.ts) can compute a dedup key for two concurrent calls
 * without waiting on memoKey's own `await crypto.subtle.digest(...)`. That
 * await matters: registering the in-flight entry only *after* awaiting the
 * real (hashed) memoKey leaves a window where a fast-settling call (e.g. a
 * `pure` leaf with no retries) can register and already be cleaned up again
 * before a second concurrent caller's own memoKey digest has even resolved,
 * silently defeating the dedup it's there to provide. This material string
 * never needs to be a hash itself -- it's only ever used as an in-process Map
 * key, never persisted or compared across processes -- so computing it
 * synchronously (no crypto) closes that window entirely: every concurrently-
 * launched call reaches the in-flight check before any of them can possibly
 * have finished running the leaf.
 */
export function memoKeyMaterial(name: string, input: unknown): string {
  return `memo:${name}:${JSON.stringify(canonicalize(stripProducedAt(input)))}`
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
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(memoKeyMaterial(name, input)))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
