// Sanitize: strip image metadata (EXIF/XMP/ICC-adjacent text chunks) and
// redact PII from text. Ported from sux-fileops's src/core/sanitize.ts during
// the suxlib absorption of sux-fileops. Text redaction is itself ported from
// sux's src/fns/redact.ts (pure regex + Luhn/IPv4 validation, no I/O); this
// version adds a context-gated bare-9-digit-SSN pattern on top.

import type { LeafFn } from '../op/types.js'
import type { Handle } from '../effects/types.js'
import { resolve, resolveText, putBytes, putText } from '../handles/handle.js'

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
  const want = types ? new Set(types) : null
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
    if (len < 2 || i + 2 + len > bytes.length) break
    if (marker === 0xe2 && len >= 2 + ICC_PROFILE_TAG.length + 2 && ICC_PROFILE_TAG.every((b, k) => bytes[i + 4 + k] === b)) {
      const seq = bytes[i + 4 + ICC_PROFILE_TAG.length]
      const total = bytes[i + 4 + ICC_PROFILE_TAG.length + 1]
      candidates.push({ offset: i, seq, total })
    }
    i += 2 + len
    if (marker === 0xda) {
      // SOS header consumed above -- skip past its entropy-coded scan data
      // byte-by-byte (mirroring stripJpegMetadata's own main loop) instead of
      // stopping the scan here, so an ICC APP2 in a later scan of a
      // progressive JPEG is still found rather than silently dropped as
      // ordinary metadata.
      while (i < bytes.length) {
        const b = bytes[i]
        if (b !== 0xff) { i++; continue }
        const next = bytes[i + 1]
        if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { i += 2; continue }
        break
      }
    }
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

const EXIF_PREFIX = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] // "Exif\0\0"
const EXIF_ORIENTATION_TAG = 0x0112

/**
 * Read the EXIF Orientation tag (IFD0, tag 0x0112, type SHORT, count 1) out of
 * an EXIF APP1 payload (the bytes *after* the "Exif\0\0" prefix, i.e. starting
 * at the TIFF header). Returns the raw 1-8 orientation value if present and
 * well-formed, else null — malformed/truncated/absent-tag EXIF is not an
 * error here, just "nothing worth preserving."
 */
function readExifOrientation(payload: Uint8Array): number | null {
  if (payload.length < 8) return null
  let little: boolean
  if (payload[0] === 0x49 && payload[1] === 0x49) little = true
  else if (payload[0] === 0x4d && payload[1] === 0x4d) little = false
  else return null
  const u16 = (o: number) => (little ? payload[o] | (payload[o + 1] << 8) : (payload[o] << 8) | payload[o + 1])
  const u32 = (o: number) =>
    little
      ? (payload[o] | (payload[o + 1] << 8) | (payload[o + 2] << 16) | (payload[o + 3] << 24)) >>> 0
      : ((payload[o] << 24) | (payload[o + 1] << 16) | (payload[o + 2] << 8) | payload[o + 3]) >>> 0
  if (payload.length < 8 || u16(2) !== 0x2a) return null
  const ifd0Offset = u32(4)
  if (ifd0Offset + 2 > payload.length) return null
  const count = u16(ifd0Offset)
  const entriesStart = ifd0Offset + 2
  if (entriesStart + count * 12 > payload.length) return null
  for (let k = 0; k < count; k++) {
    const entryOff = entriesStart + k * 12
    if (u16(entryOff) !== EXIF_ORIENTATION_TAG) continue
    if (u16(entryOff + 2) !== 3 || u32(entryOff + 4) !== 1) return null // type must be SHORT, count 1
    const value = u16(entryOff + 8)
    return value >= 1 && value <= 8 ? value : null
  }
  return null
}

/**
 * Find EXIF (APP1, "Exif\0\0"-prefixed) segments carrying a non-default
 * Orientation value, mapping segment offset -> orientation (2-8; orientation
 * 1 is "normal", nothing to preserve). Mirrors findValidIccApp2Offsets's
 * traversal (including continuing past SOS for a progressive JPEG's later
 * scans) so both scanners stay consistent about where a marker can appear.
 */
function findExifOrientationOffsets(bytes: Uint8Array): Map<number, number> {
  const offsets = new Map<number, number>()
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
    if (len < 2 || i + 2 + len > bytes.length) break
    if (marker === 0xe1 && len >= 2 + EXIF_PREFIX.length && EXIF_PREFIX.every((b, k) => bytes[i + 4 + k] === b)) {
      const payload = bytes.subarray(i + 4 + EXIF_PREFIX.length, i + 2 + len)
      const orientation = readExifOrientation(payload)
      if (orientation !== null && orientation !== 1) offsets.set(i, orientation)
    }
    i += 2 + len
    if (marker === 0xda) {
      while (i < bytes.length) {
        const b = bytes[i]
        if (b !== 0xff) { i++; continue }
        const next = bytes[i + 1]
        if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { i += 2; continue }
        break
      }
    }
  }
  return offsets
}

/**
 * Build a minimal synthetic EXIF APP1 segment carrying nothing but the
 * Orientation tag — TIFF header + a single-entry IFD0 + no next-IFD. Used in
 * place of dropping an Orientation-bearing EXIF segment outright: this
 * sanitizer rebuilds JPEGs segment-by-segment without decoding pixel data
 * (CLAUDE.md), so it can't bake a non-default orientation into the pixels
 * themselves — but it can still avoid the #360 bug (a portrait photo's pixel
 * data, stored landscape-orientation with an Orientation tag telling viewers
 * to rotate on display, rendering sideways once that tag is silently
 * stripped) by keeping just the one tag a viewer needs, the same "keep only
 * what's needed to render correctly" treatment ICC APP2/PNG's gAMA/cHRM/sRGB
 * already get.
 */
function buildOrientationApp1(orientation: number): number[] {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // "II" (little-endian), 42, IFD0 offset = 8
    0x01, 0x00, // IFD0 entry count = 1
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation & 0xff, 0x00, 0x00, 0x00, // tag 0x0112, SHORT, count 1, value
    0x00, 0x00, 0x00, 0x00, // next IFD offset = 0 (none)
  ]
  const payload = [...EXIF_PREFIX, ...tiff]
  const len = payload.length + 2
  return [0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload]
}

/**
 * Strip JPEG APPn metadata markers (APP0 kept — it's the JFIF header most
 * decoders expect; APP1 EXIF/XMP, APP13 Photoshop IPTC, COM comments are
 * dropped). APP2 segments are kept when they carry a validated ICC color
 * profile (identified by the "ICC_PROFILE\0" payload prefix and a
 * consistent sequence/total across all of a profile's segments, see
 * findValidIccApp2Offsets) — an ICC profile is rendering data, not privacy
 * metadata, matching stripPngMetadata's treatment of iCCP/sRGB/gAMA/cHRM as
 * data to preserve. Non-ICC APP2 is still dropped. An EXIF APP1 carrying a
 * non-default Orientation tag (#360) is replaced with a minimal synthetic
 * APP1 holding just that tag (buildOrientationApp1) instead of being dropped
 * outright, so a portrait phone photo doesn't silently render sideways once
 * the rest of its EXIF (GPS, camera model, ...) is stripped. Segment-level
 * rebuild: walk markers, drop the ones that carry metadata, keep SOS and the
 * entropy-coded scan data verbatim.
 */
function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG (missing SOI marker)')
  const iccOffsets = findValidIccApp2Offsets(bytes)
  const exifOrientationOffsets = findExifOrientationOffsets(bytes)
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
    // `len` includes the 2 length bytes themselves, so it can never legally be < 2;
    // and the segment it declares must fit inside the buffer — otherwise this is a
    // truncated/malformed file and must fail loudly rather than silently copy garbage.
    if (len < 2 || i + 2 + len > bytes.length) {
      throw new Error(`malformed/truncated JPEG: segment at offset ${i} declares length ${len}, runs past end of file`)
    }
    if (marker === 0xda) {
      // Start of Scan header (fixed-structure, not the entropy data) copied verbatim.
      for (let j = i; j < i + 2 + len; j++) out.push(bytes[j])
      i += 2 + len
      // Scan the entropy-coded data byte-by-byte until the next *real* marker,
      // skipping byte-stuffed 0xFF00 and in-scan RST markers (0xD0-0xD7) — both
      // are legitimate entropy-stream content, not segment boundaries — so a
      // progressive JPEG's later scans/segments (or trailing EOI) are still
      // inspected by the outer loop instead of being copied through as opaque
      // trailer data.
      while (i < bytes.length) {
        const b = bytes[i]
        if (b !== 0xff) {
          out.push(b)
          i++
          continue
        }
        const next = bytes[i + 1]
        if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          out.push(b, next)
          i += 2
          continue
        }
        break
      }
      continue
    }
    const isIccApp2 = marker === 0xe2 && iccOffsets.has(i)
    const isMetadata = ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) && !isIccApp2 // APP1-APP15, COM (ICC-bearing APP2 kept)
    if (!isMetadata) {
      for (let j = i; j < i + 2 + len; j++) out.push(bytes[j])
    } else if (marker === 0xe1 && exifOrientationOffsets.has(i)) {
      out.push(...buildOrientationApp1(exifOrientationOffsets.get(i)!))
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
 * Read the Orientation tag (0x0112) out of a raw TIFF-structured buffer —
 * shared shape between a PNG eXIf chunk's payload (no prefix) and a JPEG
 * APP1's post-"Exif\0\0" bytes. Returns null when the buffer isn't a valid
 * TIFF header, has no Orientation entry, or the value is 1 (normal — nothing
 * to preserve).
 */
function readTiffOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d
  if (!little && !big) return null
  const u16 = (o: number) => (little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1])
  const u32 = (o: number) => (little ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0 : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0)
  if (u16(2) !== 42) return null
  const ifdOffset = u32(4)
  if (ifdOffset + 2 > tiff.length) return null
  const count = u16(ifdOffset)
  const entriesEnd = ifdOffset + 2 + count * 12
  if (entriesEnd > tiff.length) return null
  for (let e = 0; e < count; e++) {
    const entryOffset = ifdOffset + 2 + e * 12
    const tag = u16(entryOffset)
    if (tag === 0x0112) {
      const value = u16(entryOffset + 8)
      return value === 1 ? null : value
    }
  }
  return null
}

/** Build a minimal PNG eXIf chunk carrying only a single-entry IFD0 (the
 *  Orientation tag) — length + 'eXIf' + 26-byte TIFF payload + fresh CRC-32. */
function buildOrientationEXif(orientation: number): number[] {
  const payload = [
    0x49, 0x49, // 'II' — little-endian
    0x2a, 0x00, // TIFF magic 42
    0x08, 0x00, 0x00, 0x00, // offset to IFD0
    0x01, 0x00, // IFD0 entry count = 1
    0x12, 0x01, // tag 0x0112 (Orientation)
    0x03, 0x00, // type 3 (SHORT)
    0x01, 0x00, 0x00, 0x00, // count = 1
    orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00, // value + padding
    0x00, 0x00, 0x00, 0x00, // next IFD offset = 0
  ]
  const len = payload.length
  const typeBytes = [0x65, 0x58, 0x49, 0x66] // 'eXIf'
  const crc = crc32(Uint8Array.from([...typeBytes, ...payload]))
  return [
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...typeBytes,
    ...payload,
    (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff,
  ]
}

/**
 * Strip PNG ancillary metadata chunks (tEXt, zTXt, iTXt free-text/XMP, eXIf,
 * time). Critical chunks (IHDR, PLTE, IDAT, IEND) and color-management chunks
 * (gAMA, cHRM, sRGB, iCCP) needed to render correctly are kept. eXIf is
 * dropped like the rest, except when it carries a non-default Orientation —
 * that tag alone is preserved in a rebuilt minimal chunk so a sanitized
 * portrait PNG doesn't silently render sideways (same fix shape as
 * stripJpegMetadata's APP1 EXIF Orientation handling).
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
    if (type === 'eXIf') {
      const orientation = readTiffOrientation(bytes.subarray(i + 8, i + 8 + len))
      if (orientation !== null) out.push(...buildOrientationEXif(orientation))
    } else if (!DROP.has(type)) {
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

// redact/scrub: Handle-based wrappers around redactText/sanitizeImage,
// following archive.ts's pack/unpack and pdf.ts's shrink — resolve the input
// Handle(s), run the pure function, put the result back as a Handle.
export type RedactInput = { handle: Handle; types?: RedactType[] }
export const redact: LeafFn = async (input, caps) => {
  const { handle, types } = input as RedactInput
  const text = await resolveText(caps.store, handle)
  const result = redactText(text, types)
  return { handle: await putText(caps.store, result.redacted, 'text/plain'), counts: result.counts }
}

export const scrub: LeafFn = async (imageHandle, caps) => {
  const bytes = await resolve(caps.store, imageHandle)
  const result = sanitizeImage(bytes)
  return { handle: await putBytes(caps.store, result.bytes, `image/${result.kind}`), kind: result.kind, strippedBytes: result.strippedBytes }
}
