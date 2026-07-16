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
export function lastWriteWins(handles: Handle[]): Handle {
  if (handles.length === 0) throw new Error('lastWriteWins: empty input')
  const unstamped = handles.find(h => h.producedAt === undefined)
  if (unstamped) throw new Error(`lastWriteWins: handle ${unstamped.r2Key} has no producedAt — stamp it via stamp(handle, caps.clock) before reconciling`)
  return handles.reduce((winner, h) => (h.producedAt! >= winner.producedAt! ? h : winner))
}
