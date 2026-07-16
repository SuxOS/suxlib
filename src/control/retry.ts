export function backoffFullJitter(attempt: number, o: { base: number; cap: number }, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(o.cap, o.base * 2 ** attempt))
}
export async function idempotencyKey(name: string, args: unknown): Promise<string> {
  const stable = JSON.stringify(args, Object.keys(args as object).sort())
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name + stable))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
