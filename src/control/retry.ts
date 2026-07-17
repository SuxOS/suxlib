export function backoffFullJitter(attempt: number, o: { base: number; cap: number }, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(o.cap, o.base * 2 ** attempt))
}
/** JSON.stringify with object keys sorted at every nesting level, not just the top one. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}
export async function idempotencyKey(name: string, args: unknown): Promise<string> {
  const stable = stableStringify(args)
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name + stable))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
