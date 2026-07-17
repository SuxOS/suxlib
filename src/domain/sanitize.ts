// Sanitize: strip image metadata (EXIF/XMP/ICC-adjacent text chunks) and
// redact PII from text. Ported from sux-fileops's src/core/sanitize.ts during
// the suxlib absorption of sux-fileops. Text redaction is itself ported from
// sux's src/fns/redact.ts (pure regex + Luhn/IPv4 validation, no I/O); this
// version adds a context-gated bare-9-digit-SSN pattern on top.

// ---------- text redaction (ported from sux/src/fns/redact.ts) ----------

export const REDACT_TYPES = ['email', 'phone', 'ssn', 'credit_card', 'ip'] as const
export type RedactType = (typeof REDACT_TYPES)[number]

// A bare 9-digit run (no separators) is ambiguous with plenty of other 9-digit
// numbers, so it's only treated as an SSN when a nearby label makes the intent
// clear (e.g. "SSN: 123456789") — otherwise it's left alone to avoid false positives.
const BARE_SSN_CONTEXT_WINDOW = 30
const BARE_SSN_CONTEXT_RE = /\b(?:ssn|social\s*security)\b/i

const PATTERNS: Array<{ type: RedactType; re: RegExp; bare?: boolean }> = [
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'ssn', re: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g },
  { type: 'ssn', re: /(?<!\d)\d{9}(?!\d)/g, bare: true },
  { type: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/g },
  {
    type: 'ip',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![0-9A-Fa-f:.])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:))(?![0-9A-Fa-f:.])/g,
  },
  {
    type: 'phone',
    re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}(?:[\s.-]\d{3,4})?\b|(?<!\d)(?:\+\d{1,3})?\d{10}(?!\d)/g,
  },
]

function luhnOk(s: string): boolean {
  const digits = s.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

function ipv4Ok(s: string): boolean {
  if (s.includes(':')) return true
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export type RedactResult = { redacted: string; counts: Record<string, number> }

/** Cap input size before running the redaction regexes over it, mirroring archive.ts's
 *  MAX_UNPACK_BYTES, pdf.ts's MAX_PDF_INPUT_BYTES, and transform.ts's
 *  MAX_TRANSFORM_INPUT_BYTES bomb guards. */
export const MAX_TEXT_INPUT_BYTES = 20_000_000

/** Redact PII from text, replacing each match with [REDACTED:type]. */
export function redactText(text: string, types?: RedactType[]): RedactResult {
  if (text.length > MAX_TEXT_INPUT_BYTES) {
    throw new Error(`text input is larger than ${MAX_TEXT_INPUT_BYTES} bytes (bomb guard).`)
  }
  const want = types && types.length ? new Set(types) : null
  const counts: Record<string, number> = {}
  for (const { type, re, bare } of PATTERNS) {
    if (want && !want.has(type)) continue
    text = text.replace(re, (m: string, offset: number) => {
      if (type === 'credit_card' && !luhnOk(m)) return m
      if (type === 'ip' && !ipv4Ok(m)) return m
      if (bare) {
        const start = Math.max(0, offset - BARE_SSN_CONTEXT_WINDOW)
        if (!BARE_SSN_CONTEXT_RE.test(text.slice(start, offset))) return m
      }
      counts[type] = (counts[type] ?? 0) + 1
      return `[REDACTED:${type}]`
    })
  }
  return { redacted: text, counts }
}

// ---------- image metadata stripping ----------
// Basic EXIF/ancillary-metadata stripping for JPEG and PNG. Rebuilds each
// format from its own segment/chunk structure rather than shelling out to a
// native image library, so this stays a pure, dependency-free function.

export type ImageKind = 'jpeg' | 'png'

export function detectImageKind(bytes: Uint8Array): ImageKind | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  return null
}

const ICC_PROFILE_TAG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00] // "ICC_PROFILE\0"

/**
 * Find the offsets of APP2 segments that carry a *validated* ICC profile: the
 * "ICC_PROFILE\0" tag is followed by a 1-based sequence number and a total
 * count (per the ICC/Adobe embedding spec, a profile over ~64KB is split
 * across multiple APP2 markers, each restating the tag+seq+count header). A
 * lone segment (seq=1, total=1) is the common case; a real multi-segment
 * profile must have every sequence number 1..total present exactly once with
 * a consistent total — anything short of that (forged/partial/duplicate
 * sequence bytes) is treated as ordinary APP2 metadata and dropped, rather
 * than risk reassembling a corrupt profile.
 */
function findValidIccApp2Offsets(bytes: Uint8Array): Set<number> {
  const candidates: Array<{ offset: number; seq: number; total: number }> = []
  let i = 2
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      if (marker === 0xd9) break
      continue
    }
    if (i + 3 >= bytes.length) break
    const len = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker === 0xda || len < 2 || i + 2 + len > bytes.length) break
    if (marker === 0xe2 && len >= 2 + ICC_PROFILE_TAG.length + 2 && ICC_PROFILE_TAG.every((b, k) => bytes[i + 4 + k] === b)) {
      const seq = bytes[i + 4 + ICC_PROFILE_TAG.length]
      const total = bytes[i + 4 + ICC_PROFILE_TAG.length + 1]
      candidates.push({ offset: i, seq, total })
    }
    i += 2 + len
  }
  if (!candidates.length) return new Set()
  // A single APP2 carrying the tag is the common (small-profile) case — keep it
  // without policing its trailing seq/total bytes. Multiple candidates only
  // reassemble into one profile if their sequence numbers exactly cover 1..total.
  if (candidates.length === 1) return new Set([candidates[0].offset])
  const total = candidates[0].total
  const seqs = new Set(candidates.map((c) => c.seq))
  const valid = total >= 1 && candidates.every((c) => c.total === total) && seqs.size === candidates.length && seqs.size === total && [...seqs].every((s) => s >= 1 && s <= total)
  return valid ? new Set(candidates.map((c) => c.offset)) : new Set()
}

/**
 * Strip JPEG APPn metadata markers (APP0 kept — it's the JFIF header most
 * decoders expect; APP1 EXIF/XMP, APP13 Photoshop IPTC, COM comments are
 * dropped). APP2 segments are kept when they carry a validated ICC color
 * profile (identified by the "ICC_PROFILE\0" payload prefix and a
 * consistent sequence/total across all of a profile's segments, see
 * findValidIccApp2Offsets) — an ICC profile is rendering data, not privacy
 * metadata, matching stripPngMetadata's treatment of iCCP/sRGB/gAMA/cHRM as
 * data to preserve. Non-ICC APP2 is still dropped. Segment-level rebuild:
 * walk markers, drop the ones that carry metadata, keep SOS and the
 * entropy-coded scan data verbatim.
 */
function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG (missing SOI marker)')
  const iccOffsets = findValidIccApp2Offsets(bytes)
  const out: number[] = [0xff, 0xd8]
  let i = 2
  let terminated = false
  // Markers that carry no metadata and must be passed through unmodified
  // (structural: DQT, DHT, SOF, DRI, etc.); APPn (except APP0/JFIF) and COM
  // are dropped. SOS (0xDA) ends the header section — everything after it
  // (entropy-coded scan data + trailing EOI) is copied through verbatim.
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      // Shouldn't happen in a well-formed header; bail out and copy the rest.
      for (let j = i; j < bytes.length; j++) out.push(bytes[j])
      terminated = true
      break
    }
    if (i + 1 >= bytes.length) throw new Error('malformed/truncated JPEG: marker byte missing at end of file')
    const marker = bytes[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Markers with no payload (SOI/TEM/RSTn).
      out.push(0xff, marker)
      i += 2
      continue
    }
    if (marker === 0xd9) {
      // EOI
      out.push(0xff, marker)
      i += 2
      terminated = true
      break
    }
    if (i + 3 >= bytes.length) throw new Error('malformed/truncated JPEG: segment length field runs past end of file')
    const len = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker === 0xda) {
      // Start of Scan: header + all remaining bytes (entropy data) verbatim.
      for (let j = i; j < bytes.length; j++) out.push(bytes[j])
      terminated = true
      break
    }
    // `len` includes the 2 length bytes themselves, so it can never legally be < 2;
    // and the segment it declares must fit inside the buffer — otherwise this is a
    // truncated/malformed file and must fail loudly rather than silently copy garbage.
    if (len < 2 || i + 2 + len > bytes.length) {
      throw new Error(`malformed/truncated JPEG: segment at offset ${i} declares length ${len}, runs past end of file`)
    }
    const isIccApp2 = marker === 0xe2 && iccOffsets.has(i)
    const isMetadata = ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) && !isIccApp2 // APP1-APP15, COM (ICC-bearing APP2 kept)
    if (!isMetadata) {
      for (let j = i; j < i + 2 + len; j++) out.push(bytes[j])
    }
    i += 2 + len
  }
  // The loop only exits normally (without throwing) via one of the `terminated = true`
  // breaks above; falling off the end of the while condition means the header section
  // ran out of bytes before ever reaching scan data or EOI — a truncated file.
  if (!terminated) throw new Error('malformed/truncated JPEG: reached end of file without SOS scan data or an EOI marker')
  return Uint8Array.from(out)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** CRC-32 (PNG's chunk checksum), computed fresh for each rebuilt chunk. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Strip PNG ancillary metadata chunks (tEXt, zTXt, iTXt free-text/XMP, eXIf,
 * time). Critical chunks (IHDR, PLTE, IDAT, IEND) and color-management chunks
 * (gAMA, cHRM, sRGB, iCCP) needed to render correctly are kept.
 */
function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG (bad signature)')
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])
  const out: number[] = [...PNG_SIGNATURE]
  let i = 8
  let sawIend = false
  while (i + 8 <= bytes.length) {
    // Read the 4-byte big-endian chunk length as UNSIGNED. `<<` coerces to a
    // signed 32-bit int in JS, so a length with the high bit set (e.g. a
    // malformed/hostile chunk claiming ~2-4GB) would otherwise come out
    // negative, making chunkEnd wrap and the walker spin/misbehave (DoS).
    // `>>> 0` forces the unsigned interpretation.
    const len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7])
    // Bounds-check against what's actually left in the buffer before trusting
    // the declared length — a malformed/truncated PNG can claim a length far
    // larger than the remaining bytes.
    const remaining = bytes.length - (i + 8)
    if (len > remaining) throw new Error(`malformed PNG: chunk '${type}' at offset ${i} declares length ${len} but only ${remaining} bytes remain`)
    const chunkEnd = i + 8 + len + 4
    // A chunk whose declared length runs past the actual buffer (missing CRC) is a
    // truncated or corrupted file — fail loudly instead of silently truncating the
    // rebuilt image. (Kept as a belt-and-suspenders check alongside the `remaining`
    // check above, which already implies this for a well-formed `len`.)
    if (chunkEnd > bytes.length) {
      throw new Error(`malformed PNG: chunk '${type}' at offset ${i} declares length ${len}, runs past end of file`)
    }
    if (!DROP.has(type)) {
      for (let j = i; j < chunkEnd; j++) out.push(bytes[j])
    }
    i = chunkEnd
    if (type === 'IEND') {
      sawIend = true
      break
    }
  }
  // Running out of bytes before ever seeing IEND (including a file with no chunks at
  // all after the signature) is a truncated file — throw rather than silently return a
  // short, invalid "sanitized" image.
  if (!sawIend) throw new Error('malformed/truncated PNG: reached end of file without an IEND chunk')
  return Uint8Array.from(out)
}

/** Cap input size before parsing so a crafted image can't OOM the process/isolate,
 *  mirroring archive.ts's MAX_UNPACK_BYTES and pdf.ts's MAX_PDF_INPUT_BYTES bomb guards. */
export const MAX_IMAGE_INPUT_BYTES = 50_000_000

export type SanitizeImageResult = { kind: ImageKind; bytes: Uint8Array; strippedBytes: number }

/** Strip embedded metadata from a JPEG or PNG. Throws on any other format. */
export function sanitizeImage(bytes: Uint8Array): SanitizeImageResult {
  if (bytes.length > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`image input is larger than ${MAX_IMAGE_INPUT_BYTES} bytes (bomb guard).`)
  }
  const kind = detectImageKind(bytes)
  if (!kind) throw new Error('unsupported image format for sanitize (expected JPEG or PNG magic bytes)')
  const out = kind === 'jpeg' ? stripJpegMetadata(bytes) : stripPngMetadata(bytes)
  return { kind, bytes: out, strippedBytes: bytes.length - out.length }
}
