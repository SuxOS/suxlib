import type { Store, Handle } from '../effects/types.js'
import { putText, resolveText } from '../handles/handle.js'
export type FieldPolicy = 'last-write-wins' | 'union' | 'keep-first'
export type ReconcileOpts =
  | { mode: 'faithful-union' }
  | { mode: 'last-write-wins' }
  | { mode: 'field-merge'; defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy> }
export async function faithfulUnion(handles: Handle[], store: Store): Promise<Handle> {
  const seen = new Set<string>(); const blocks: string[] = []
  for (const h of handles) {
    if (seen.has(h.sha256)) continue; seen.add(h.sha256)
    blocks.push(`<!-- source: ${h.r2Key} -->\n${await resolveText(store, h)}`)
  }
  return putText(store, blocks.join('\n\n'), 'text/markdown')
}
