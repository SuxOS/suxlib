// Archive create/extract: zip, gzip, tar. Pure functions — no I/O, no fetch,
// no filesystem access of their own (safeExtractPath resolves paths but never
// touches the filesystem — that's left to a caller/adapter). Ported from
// sux-fileops's src/core/archive.ts (itself adapted from sux's src/fns/archive.ts)
// during the suxlib absorption of sux-fileops.

import { Gunzip, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import type { LeafFn } from '../op/types.js'
import { resolve, putBytes } from '../handles/handle.js'

/** Cap total decompressed output so a zip/gzip bomb can't OOM the process. */
export const MAX_UNPACK_BYTES = 20_000_000
/** Cap entry count so a many-file archive can't exhaust memory. */
export const MAX_ENTRIES = 2_000
/** Don't inline megabytes of decoded text per entry. */
export const MAX_TEXT = 100_000

export type ArchiveFile = { name: string; data: Uint8Array }
export type UnpackedEntry = { name: string; bytes: number; text?: string; truncated?: boolean; data: Uint8Array }

/**
 * Resolve an archive entry name against a destination directory, rejecting
 * any entry that would escape it (Zip-Slip / Tar-Slip guard). Callers that
 * write extracted entries to disk MUST route every entry through this
 * function before touching the filesystem — never join(destDir, entry.name)
 * directly, since a malicious entry name like '../../etc/passwd' or an
 * absolute path ('/etc/passwd') would write outside destDir.
 *
 * Throws if the entry name is empty, absolute, or resolves outside destDir.
 */
export function safeExtractPath(destDir: string, entryName: string): string {
  if (!entryName || entryName.trim() === '') throw new Error('archive entry has an empty name.')
  if (isAbsolute(entryName)) throw new Error(`archive entry has an absolute path (rejected — zip-slip guard): '${entryName}'`)
  const resolvedDest = resolvePath(destDir)
  const resolvedEntry = resolvePath(resolvedDest, entryName)
  if (resolvedEntry !== resolvedDest && !resolvedEntry.startsWith(resolvedDest + sep)) {
    throw new Error(`archive entry escapes the extraction directory (rejected — zip-slip guard): '${entryName}'`)
  }
  return resolvedEntry
}

/** Heuristic: does this byte run decode cleanly as UTF-8 without binary control noise? */
function looksUtf8(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  const text = new TextDecoder().decode(bytes)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0xfffd) return false
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false
  }
  return true
}

function decodeEntry(name: string, data: Uint8Array): UnpackedEntry {
  const e: UnpackedEntry = { name, bytes: data.length, data }
  if (looksUtf8(data)) {
    const text = strFromU8(data)
    if (text.length > MAX_TEXT) {
      e.text = text.slice(0, MAX_TEXT)
      e.truncated = true
    } else {
      e.text = text
    }
  }
  return e
}

/** Gunzip with a hard budget: stream-inflate and abort once output passes MAX_UNPACK_BYTES. */
function gunzipCapped(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const gz = new Gunzip((chunk) => {
    total += chunk.length
    if (total > MAX_UNPACK_BYTES) throw new Error(`gzip decompresses to more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
    chunks.push(chunk)
  })
  gz.push(bytes, true)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// ---------- zip ----------

export function zipCreate(files: ArchiveFile[]): Uint8Array {
  if (!files.length) throw new Error('pack needs at least one file.')
  if (files.length > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
  let totalBytes = 0
  for (const f of files) {
    if (!f?.name) throw new Error('every file needs a name.')
    totalBytes += f.data.length
  }
  if (totalBytes > MAX_UNPACK_BYTES) throw new Error(`archive input totals more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
  const record: Record<string, Uint8Array> = {}
  for (const f of files) {
    // Keying by name means a duplicate would silently overwrite (drop) the
    // earlier entry's data — refuse rather than lose a file.
    if (f.name in record) throw new Error(`duplicate entry name: '${f.name}' — every file in an archive needs a unique name.`)
    record[f.name] = f.data
  }
  return zipSync(record, { level: 6 })
}

export function zipExtract(bytes: Uint8Array): UnpackedEntry[] {
  let count = 0
  let declared = 0
  const files = unzipSync(bytes, {
    filter(f) {
      if (++count > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
      declared += f.originalSize
      if (declared > MAX_UNPACK_BYTES) throw new Error(`archive decompresses to more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
      return true
    },
  })
  return Object.entries(files).map(([name, data]) => decodeEntry(name, data))
}

// ---------- gzip ----------

export function gzipCreate(data: Uint8Array): Uint8Array {
  if (data.length > MAX_UNPACK_BYTES) throw new Error(`archive input totals more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
  return gzipSync(data, { level: 6 })
}

export function gzipExtract(bytes: Uint8Array): UnpackedEntry {
  const data = gunzipCapped(bytes)
  return decodeEntry('data', data)
}

// ---------- tar (USTAR, uncompressed) ----------
// Minimal pure-JS tar reader/writer. No compression — pair with gzip above for
// .tar.gz if needed (gzipCreate(tarCreate(files))).

const BLOCK = 512

function padTo(n: number, size: number): number {
  return Math.ceil(n / size) * size
}

function writeOctal(value: number, length: number): Uint8Array {
  const s = value.toString(8).padStart(length - 1, '0') + '\0'
  return strToU8(s.slice(0, length))
}

function readOctal(bytes: Uint8Array): number {
  const s = strFromU8(bytes).replace(/\0.*$/, '').trim()
  return s ? parseInt(s, 8) || 0 : 0
}

function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const nameBytes = strToU8(name.slice(0, 100))
  h.set(nameBytes, 0)
  h.set(writeOctal(0o644, 8), 100) // mode
  h.set(writeOctal(0, 8), 108) // uid
  h.set(writeOctal(0, 8), 116) // gid
  h.set(writeOctal(size, 12), 124) // size
  h.set(writeOctal(Math.floor(Date.now() / 1000), 12), 136) // mtime
  h.set(strToU8('        '), 148) // checksum placeholder (8 spaces)
  h[156] = '0'.charCodeAt(0) // typeflag: regular file
  h.set(strToU8('ustar\0'), 257) // magic
  h.set(strToU8('00'), 263) // version

  let checksum = 0
  for (let i = 0; i < BLOCK; i++) checksum += h[i]
  h.set(writeOctal(checksum, 8), 148)
  return h
}

/** Build an uncompressed USTAR tar archive from a set of files. */
export function tarCreate(files: ArchiveFile[]): Uint8Array {
  if (!files.length) throw new Error('pack needs at least one file.')
  if (files.length > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
  let declaredBytes = 0
  for (const f of files) {
    if (!f?.name) throw new Error('every file needs a name.')
    if (strToU8(f.name).length > 100) throw new Error(`tar entry name too long (>100 bytes): '${f.name}'`)
    declaredBytes += f.data.length
  }
  if (declaredBytes > MAX_UNPACK_BYTES) throw new Error(`archive input totals more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
  const parts: Uint8Array[] = []
  let total = 0
  for (const f of files) {
    const header = tarHeader(f.name, f.data.length)
    const paddedSize = padTo(f.data.length, BLOCK)
    const body = new Uint8Array(paddedSize)
    body.set(f.data, 0)
    parts.push(header, body)
    total += BLOCK + paddedSize
  }
  const footer = new Uint8Array(BLOCK * 2) // two zero blocks terminate the archive
  parts.push(footer)
  total += footer.length

  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * Result of a tar extract: `entries` are the inlined regular files;
 * `skipped` names every entry dropped because its typeflag isn't a regular
 * file (symlinks, hardlinks, devices, etc. — dropped as a symlink-attack
 * guard, but callers should be able to tell extraction was partial).
 */
export type TarExtractResult = { entries: UnpackedEntry[]; skipped: Array<{ name: string; typeflag: string }> }

/** Parse an uncompressed USTAR tar archive. */
export function tarExtract(bytes: Uint8Array): TarExtractResult {
  const entries: UnpackedEntry[] = []
  const skipped: Array<{ name: string; typeflag: string }> = []
  let off = 0
  let count = 0
  let declared = 0
  while (off + BLOCK <= bytes.length) {
    const header = bytes.subarray(off, off + BLOCK)
    // Two consecutive zero blocks (or a header of all zero bytes) mark the end.
    if (header.every((b) => b === 0)) break
    const nameBytes = header.subarray(0, 100)
    const nameEnd = nameBytes.indexOf(0)
    const name = strFromU8(nameEnd === -1 ? nameBytes : nameBytes.subarray(0, nameEnd))
    const size = readOctal(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] || 0)
    off += BLOCK

    if (++count > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
    declared += size
    if (declared > MAX_UNPACK_BYTES) throw new Error(`archive decompresses to more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)

    const data = bytes.subarray(off, off + size)
    off += padTo(size, BLOCK)

    // '0' and '\0' (header[156] is never absent, so fromCharCode always yields
    // a real char -- '\0' covers pre-POSIX tar, never an empty string) are
    // regular files; everything else (directories, symlinks, hardlinks, devices,
    // ...) is dropped and recorded in `skipped`.
    if (typeflag === '0' || typeflag === '\0') {
      entries.push(decodeEntry(name, new Uint8Array(data)))
    } else {
      skipped.push({ name, typeflag })
    }
  }
  return { entries, skipped }
}

// ---------- unified entry points ----------

export const ARCHIVE_FORMATS = ['zip', 'gzip', 'tar'] as const
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number]

export function archiveCreate(format: ArchiveFormat, files: ArchiveFile[]): Uint8Array {
  if (files.length > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
  let totalBytes = 0
  for (const f of files) totalBytes += f.data.length
  if (totalBytes > MAX_UNPACK_BYTES) throw new Error(`archive input totals more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
  switch (format) {
    case 'zip':
      return zipCreate(files)
    case 'tar':
      return tarCreate(files)
    case 'gzip':
      if (files.length !== 1) throw new Error(`gzip packs exactly one file — got ${files.length}. Use format='zip' or 'tar' for multiple.`)
      return gzipCreate(files[0].data)
  }
}

export function archiveExtract(format: ArchiveFormat, bytes: Uint8Array): UnpackedEntry[] {
  switch (format) {
    case 'zip':
      return zipExtract(bytes)
    case 'tar':
      return tarExtract(bytes).entries
    case 'gzip':
      return [gzipExtract(bytes)]
  }
}

export const ARCHIVE_MIME: Record<ArchiveFormat, string> = {
  zip: 'application/zip',
  gzip: 'application/gzip',
  tar: 'application/x-tar',
}

// ---------- op-engine leaf ----------
// unzip: Handle -> Handle[], used by the tracer-bullet op tree (assimilatePdfs).
// Kept alongside the pure functions above rather than re-plumbed through
// zipExtract, since it operates on Handles (claim-check) rather than raw bytes.
export const unzip: LeafFn = async (zipHandle, caps) => {
  const bytes = await resolve(caps.store, zipHandle)
  const files = unzipSync(bytes)
  return Promise.all(
    Object.entries(files).map(([name, data]) =>
      putBytes(caps.store, data, name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
    ),
  )
}
