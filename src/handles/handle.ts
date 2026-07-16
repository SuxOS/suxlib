import type { Store, Handle, Clock } from '../effects/types.js'
export const putBytes = (s: Store, b: Uint8Array, type: string) => s.put(b, type)
export const resolve = (s: Store, h: Handle) => s.get(h)
export const putText = (s: Store, t: string, type = 'text/plain') => s.put(new TextEncoder().encode(t), type)
export const resolveText = async (s: Store, h: Handle) => new TextDecoder().decode(await s.get(h))
export const stamp = (h: Handle, clock: Clock): Handle => ({ ...h, producedAt: clock.now() })
