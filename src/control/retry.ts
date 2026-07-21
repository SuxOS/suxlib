export function backoffFullJitter(attempt: number, o: { base: number; cap: number }, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(o.cap, o.base * 2 ** attempt))
}
// `stack` tracks the current ancestor chain (not every object ever visited)
// so a cycle throws a clear error while a DAG -- the same object reachable
// via two sibling paths, which isn't circular -- still canonicalizes fine.
export function canonicalize(v: unknown, stack: Set<object> = new Set()): unknown {
  // Date has no own enumerable properties (Object.keys(new Date()) === []),
  // so the generic object branch below would silently collapse every Date to
  // {} regardless of its timestamp -- special-cased the way JSON.stringify
  // special-cases it via toJSON(), rather than falling through.
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) {
    if (stack.has(v)) throw new TypeError('canonicalize: circular reference')
    stack.add(v)
    const result = v.map(x => canonicalize(x, stack))
    stack.delete(v)
    return result
  }
  if (v && typeof v === 'object') {
    if (stack.has(v)) throw new TypeError('canonicalize: circular reference')
    stack.add(v)
    const o = v as Record<string, unknown>
    const result = Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = canonicalize(o[k], stack); return acc }, Object.create(null))
    stack.delete(v)
    return result
  }
  return v
}
export async function idempotencyKey(name: string, args: unknown): Promise<string> {
  const stable = JSON.stringify(canonicalize(args))
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${name}:${stable}`))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
