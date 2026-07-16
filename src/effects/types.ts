export interface Handle { r2Key: string; sha256: string; type: string; size: number }
export interface Store { put(bytes: Uint8Array, type: string): Promise<Handle>; get(h: Handle): Promise<Uint8Array> }
export interface Llm { markdownFromPdf(bytes: Uint8Array): Promise<string>; summarize(text: string): Promise<string> }
export interface Clock { now(): number }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export class MemoryStore implements Store {
  private m = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array, type: string): Promise<Handle> {
    const sha = await sha256Hex(bytes); const r2Key = `cas/${sha}`
    if (!this.m.has(r2Key)) this.m.set(r2Key, bytes)
    return { r2Key, sha256: sha, type, size: bytes.byteLength }
  }
  async get(h: Handle): Promise<Uint8Array> {
    const b = this.m.get(h.r2Key); if (!b) throw new Error(`handle not found: ${h.r2Key}`); return b
  }
}
