export function backoffFullJitter(attempt: number, o: { base: number; cap: number }, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(o.cap, o.base * 2 ** attempt))
}
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = canonicalize(o[k]); return acc }, Object.create(null))
  }
  return v
}
export async function idempotencyKey(name: string, args: unknown): Promise<string> {
  const stable = JSON.stringify(canonicalize(args))
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name + stable))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
