import { test, expect } from 'vitest'
import { redactText, sanitizeImage, detectImageKind, redact, scrub, MAX_IMAGE_INPUT_BYTES, MAX_TEXT_INPUT_BYTES } from '../../src/domain/sanitize.js'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, putText, resolve, resolveText } from '../../src/handles/handle.js'

test('redactText rejects text over MAX_TEXT_INPUT_BYTES', () => {
  const big = 'a'.repeat(MAX_TEXT_INPUT_BYTES + 1)
  expect(() => redactText(big)).toThrow(/bomb guard/)
})

test('redactText redacts email, phone, ssn, valid credit card and ip', () => {
  const out = redactText('Email a@b.com, call 415-555-0198, SSN 123-45-6789, card 4111 1111 1111 1111, ip 10.0.0.1')
  expect(out.redacted).toContain('[REDACTED:email]')
  expect(out.redacted).toContain('[REDACTED:phone]')
  expect(out.redacted).toContain('[REDACTED:ssn]')
  expect(out.redacted).toContain('[REDACTED:credit_card]')
  expect(out.redacted).toContain('[REDACTED:ip]')
  expect(out.counts.credit_card).toBe(1)
})

test('redactText leaves Luhn-invalid card runs and out-of-range IPs alone', () => {
  const out = redactText('order 1234567890123456 from 999.1.1.1', ['credit_card', 'ip'])
  expect(out.redacted).toContain('1234567890123456')
  expect(out.redacted).toContain('999.1.1.1')
  expect(out.counts.credit_card).toBeUndefined()
})

test('redactText honors the types subset', () => {
  const out = redactText('a@b.com and 10.0.0.1', ['email'])
  expect(out.redacted).toContain('[REDACTED:email]')
  expect(out.redacted).toContain('10.0.0.1')
})

test('redactText treats an explicit empty types array as "redact none", not "redact all"', () => {
  const out = redactText('a@b.com', [])
  expect(out.redacted).toBe('a@b.com')
  expect(out.counts).toEqual({})
})

test('redactText only redacts a bare 9-digit SSN when nearby context labels it', () => {
  const labeled = redactText('SSN: 123456789')
  expect(labeled.redacted).toContain('[REDACTED:ssn]')
  const unlabeled = redactText('order number 123456789')
  expect(unlabeled.redacted).toContain('123456789')
})

test('redact (Handle-based leaf) round-trips text through a Store and reports the same counts as redactText', async () => {
  const store = new MemoryStore()
  const handle = await putText(store, 'contact a@b.com')
  const result = await redact({ handle }, { store } as any)
  expect(result.counts.email).toBe(1)
  expect(await resolveText(store, result.handle)).toBe('contact [REDACTED:email]')
})

test('redact (Handle-based leaf) honors the types subset', async () => {
  const store = new MemoryStore()
  const handle = await putText(store, 'a@b.com and 10.0.0.1')
  const result = await redact({ handle, types: ['email'] }, { store } as any)
  expect(await resolveText(store, result.handle)).toBe('[REDACTED:email] and 10.0.0.1')
})

test('detectImageKind reads magic bytes for jpeg/png and returns null otherwise', () => {
  expect(detectImageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
  expect(detectImageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png')
  expect(detectImageKind(new Uint8Array([0, 0, 0, 0]))).toBeNull()
})

test('sanitizeImage strips PNG ancillary metadata chunks and keeps critical ones', () => {
  const png = buildMinimalPng({ tEXt: true })
  const result = sanitizeImage(png)
  expect(result.kind).toBe('png')
  expect(result.strippedBytes).toBeGreaterThan(0)
  // Critical chunks (IHDR/IDAT/IEND) must survive; re-run detectImageKind on the output.
  expect(detectImageKind(result.bytes)).toBe('png')
})

test('scrub (Handle-based leaf) round-trips a PNG through a Store and reports the same stats as sanitizeImage', async () => {
  const store = new MemoryStore()
  const png = buildMinimalPng({ tEXt: true })
  const handle = await putBytes(store, png, 'image/png')
  const result = await scrub(handle, { store } as any)
  expect(result.kind).toBe('png')
  expect(result.strippedBytes).toBeGreaterThan(0)
  expect(detectImageKind(await resolve(store, result.handle))).toBe('png')
})

test('sanitizeImage rejects an image over MAX_IMAGE_INPUT_BYTES', () => {
  const big = new Uint8Array(MAX_IMAGE_INPUT_BYTES + 1)
  big.set([0x89, 0x50, 0x4e, 0x47])
  expect(() => sanitizeImage(big)).toThrow(/bomb guard/)
})

test('sanitizeImage throws on an unsupported format', () => {
  expect(() => sanitizeImage(new Uint8Array([1, 2, 3, 4]))).toThrow(/unsupported image format/)
})

test('sanitizeImage keeps an ICC color profile (APP2) while dropping EXIF (APP1) from a JPEG', () => {
  const jpeg = buildMinimalJpeg()
  const result = sanitizeImage(jpeg)
  expect(result.kind).toBe('jpeg')
  const bytes = Array.from(result.bytes)
  const iccTag = Array.from(new TextEncoder().encode('ICC_PROFILE\0'))
  const hasIcc = bytes.some((_, i) => iccTag.every((b, k) => bytes[i + k] === b))
  expect(hasIcc).toBe(true)
  const exifTag = Array.from(new TextEncoder().encode('Exif\0\0'))
  const hasExif = bytes.some((_, i) => exifTag.every((b, k) => bytes[i + k] === b))
  expect(hasExif).toBe(false)
})

test('sanitizeImage strips a metadata segment placed after the first SOS scan of a progressive JPEG', () => {
  const soi = new Uint8Array([0xff, 0xd8])
  // First scan: SOS header (len=2, no extra header bytes) + entropy data containing
  // a stuffed 0xFF00 byte and an in-scan RST0 marker, both of which must be treated
  // as scan content rather than segment boundaries.
  const sos1 = new Uint8Array([0xff, 0xda, 0x00, 0x02, 0xaa, 0xff, 0x00, 0xff, 0xd0, 0xbb])
  const app1Exif = jpegSegment(0xe1, new TextEncoder().encode('Exif\0\0second-scan-exif'))
  // Second scan, terminated by EOI.
  const sos2 = new Uint8Array([0xff, 0xda, 0x00, 0x02, 0xcc, 0xdd, 0xff, 0xd9])
  const parts = [soi, sos1, app1Exif, sos2]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const jpeg = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    jpeg.set(p, off)
    off += p.length
  }
  const result = sanitizeImage(jpeg)
  const text = new TextDecoder('latin1').decode(result.bytes)
  expect(text).not.toContain('second-scan-exif')
  const bytes = Array.from(result.bytes)
  // The first scan's stuffed 0xFF00 and RST0 marker survive untouched (real entropy content).
  expect(bytes.slice(6, 12)).toEqual([0xaa, 0xff, 0x00, 0xff, 0xd0, 0xbb])
  // Second scan's entropy data and EOI still present after the stripped APP1.
  expect(bytes.slice(-4)).toEqual([0xcc, 0xdd, 0xff, 0xd9])
})

test('sanitizeImage preserves all segments of a multi-segment (>64KB) ICC profile', () => {
  const enc = new TextEncoder()
  const tag = enc.encode('ICC_PROFILE\0')
  const iccSegment = (seq: number, total: number, data: Uint8Array) => {
    const payload = new Uint8Array(tag.length + 2 + data.length)
    payload.set(tag, 0)
    payload[tag.length] = seq
    payload[tag.length + 1] = total
    payload.set(data, tag.length + 2)
    return jpegSegment(0xe2, payload)
  }
  const soi = new Uint8Array([0xff, 0xd8])
  const chunk1 = iccSegment(1, 2, enc.encode('profile-part-1'))
  const chunk2 = iccSegment(2, 2, enc.encode('profile-part-2'))
  const sos = new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x00, 0x01, 0xff, 0xd9])
  const parts = [soi, chunk1, chunk2, sos]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const jpeg = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    jpeg.set(p, off)
    off += p.length
  }
  const result = sanitizeImage(jpeg)
  const text = new TextDecoder('latin1').decode(result.bytes)
  expect(text).toContain('profile-part-1')
  expect(text).toContain('profile-part-2')
})

test('sanitizeImage drops multiple ICC-tagged APP2 segments whose sequence/total bytes are inconsistent', () => {
  const enc = new TextEncoder()
  const tag = enc.encode('ICC_PROFILE\0')
  const iccSegment = (seq: number, total: number, data: Uint8Array) => {
    const payload = new Uint8Array(tag.length + 2 + data.length)
    payload.set(tag, 0)
    payload[tag.length] = seq
    payload[tag.length + 1] = total
    payload.set(data, tag.length + 2)
    return jpegSegment(0xe2, payload)
  }
  const soi = new Uint8Array([0xff, 0xd8])
  // Two segments both claiming sequence 1 of a 2-part profile — never resolves to a
  // complete 1..total set, so this can't be reassembled into a valid profile.
  const chunk1 = iccSegment(1, 2, enc.encode('profile-part-1'))
  const chunk2 = iccSegment(1, 2, enc.encode('profile-part-2'))
  const sos = new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x00, 0x01, 0xff, 0xd9])
  const parts = [soi, chunk1, chunk2, sos]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const jpeg = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    jpeg.set(p, off)
    off += p.length
  }
  const result = sanitizeImage(jpeg)
  const text = new TextDecoder('latin1').decode(result.bytes)
  expect(text).not.toContain('profile-part-1')
  expect(text).not.toContain('profile-part-2')
})

// ---- minimal JPEG builder for the ICC-preservation test above ----
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2
  const out = new Uint8Array(2 + 2 + payload.length)
  out[0] = 0xff
  out[1] = marker
  out[2] = (len >> 8) & 0xff
  out[3] = len & 0xff
  out.set(payload, 4)
  return out
}
function buildMinimalJpeg(): Uint8Array {
  const soi = new Uint8Array([0xff, 0xd8])
  const app1Exif = jpegSegment(0xe1, new TextEncoder().encode('Exif\0\0extra-exif-bytes'))
  const app2Icc = jpegSegment(0xe2, new TextEncoder().encode('ICC_PROFILE\0fake-profile-bytes'))
  const sos = new Uint8Array([0xff, 0xda, 0x00, 0x02, 0x00, 0x01, 0xff, 0xd9]) // header + dummy entropy data + EOI
  const parts = [soi, app1Exif, app2Icc, sos]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ---- minimal PNG builder for the sanitize test above ----
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length
  const out = new Uint8Array(4 + 4 + len + 4)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, len)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcInput = out.slice(4, 8 + len)
  dv.setUint32(8 + len, crc32(crcInput))
  return out
}
function buildMinimalPng(opts: { tEXt?: boolean }): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = chunk('IHDR', new Uint8Array(13)) // zeroed header, fine for a metadata-strip test
  const parts = [sig, ihdr]
  if (opts.tEXt) parts.push(chunk('tEXt', new TextEncoder().encode('Comment\0hello')))
  parts.push(chunk('IDAT', new Uint8Array([0])))
  parts.push(chunk('IEND', new Uint8Array(0)))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
