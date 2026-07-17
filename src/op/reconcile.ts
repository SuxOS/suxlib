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
export async function fieldMerge(
  handles: Handle[],
  store: Store,
  opts: { defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy> } = {},
): Promise<Handle> {
  if (handles.length === 0) throw new Error('fieldMerge: empty input')
  const defaultPolicy = opts.defaultPolicy ?? 'last-write-wins'
  const docs = await Promise.all(handles.map(async h => JSON.parse(await resolveText(store, h)) as Record<string, unknown>))
  const merged: Record<string, unknown> = {}
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc)) {
      // Reject prototype-polluting keys (CWE-1321): JSON.parse assigns "__proto__" as a plain
      // own property, but `merged[k] = v` below is a bracket assignment on a normal object —
      // for k === '__proto__' that invokes Object.prototype's inherited setter and reassigns
      // merged's prototype to attacker-controlled `v` instead of setting a data field. Skip
      // this and the other well-known dangerous keys before they ever reach an assignment.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      const policy = opts.policy?.[k] ?? defaultPolicy
      if (policy === 'keep-first') { if (!Object.prototype.hasOwnProperty.call(merged, k)) merged[k] = v; continue }
      if (policy === 'union' && Array.isArray(v)) {
        const prior = Array.isArray(merged[k]) ? merged[k] as unknown[] : []
        merged[k] = [...new Set([...prior, ...v])]
        continue
      }
      merged[k] = v   // 'last-write-wins' (default): later handle's value overwrites
    }
  }
  return putText(store, JSON.stringify(merged), 'application/json')
}
export async function runReconcile(opts: ReconcileOpts, handles: Handle[], store: Store): Promise<Handle> {
  switch (opts.mode) {
    case 'faithful-union': return faithfulUnion(handles, store)
    case 'last-write-wins': return lastWriteWins(handles)
    case 'field-merge': return fieldMerge(handles, store, opts)
  }
}
