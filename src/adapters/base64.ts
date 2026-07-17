// Shared base64 <-> bytes marshalling for adapters (http.ts, mcp.ts). Not core
// logic — this is I/O glue, kept out of src/domain/* which stays pure/dependency-light.

// Reject an oversized base64 string before the O(n) atob()/decode loop runs. Unlike
// http.ts's readCappedBody (which bounds the whole request body before it's buffered),
// mcp.ts hands tool input straight to b64ToBytes with no size check of its own — every
// domain-level bomb guard (MAX_UNPACK_BYTES, MAX_PDF_INPUT_BYTES, MAX_IMAGE_INPUT_BYTES)
// checks bytes.length, i.e. only runs *after* decode. This cap, applied here so every
// caller gets it for free, mirrors http.ts's MAX_REQUEST_BODY_BYTES and keeps a huge
// payload from being decoded before any of those guards get a chance to fire.
export const MAX_B64_INPUT_BYTES = 50_000_000

export function b64ToBytes(b64: string): Uint8Array {
  if (b64.length > MAX_B64_INPUT_BYTES) {
    throw new Error(`base64 input is larger than ${MAX_B64_INPUT_BYTES} characters (bomb guard).`)
  }
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
