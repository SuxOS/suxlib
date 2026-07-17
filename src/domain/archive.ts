// Archive create/extract: zip, gzip, tar. Pure functions — no I/O, no fetch,
// no filesystem access of their own (safeExtractPath resolves paths but never
// touches the filesystem — that's left to a caller/adapter). Ported from
// sux-fileops's src/core/archive.ts (itself adapted from sux's src/fns/archive.ts)
// during the suxlib absorption of sux-fileops.

import { Gunzip, Unzip, UnzipInflate, UnzipPassThrough, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import type { LeafFn } from '../op/types.js'
import { resolve, putBytes } from '../handles/handle.js'

/** Cap total decompressed output so a zip/gzip bomb can't OOM the process. */
export const MAX_UNPACK_BYTES = 20_000_000
/** Cap entry count so a many-file archive can't exhaust memory. */
export const MAX_ENTRIES = 2_000
/** Don't inline megabytes of decoded text per entry. */
export const MAX_TEXT = 100_000

export type ArchiveFile = { name: string; data: Uint8Array; mtime?: number }
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
  // Object.create(null) rather than {}: a plain object inherits every
  // Object.prototype member name ('constructor', 'toString', ...) as an own
  // "in" hit, so `f.name in record` would falsely report e.g. a file named
  // 'constructor' as a duplicate on its first (only) occurrence. A
  // null-prototype object has no inherited names to collide with.
  const record: Record<string, Uint8Array> = Object.create(null)
  for (const f of files) {
    // fflate's zipSync (via its internal `fltn` flattening step) keys its own
    // scratch object by entry name and assigns to it directly — for the
    // literal name '__proto__' that invokes the Annex B setter on fflate's
    // object and corrupts its internal state instead of storing the entry.
    // That's a bug in fflate itself we can't fix from here, so refuse before
    // ever calling zipSync rather than let it fail confusingly downstream.
    if (f.name === '__proto__') throw new Error(`file name '__proto__' can't be packed into a zip (rejected — the underlying zip library mishandles this exact name).`)
    // Keying by name means a duplicate would silently overwrite (drop) the
    // earlier entry's data — refuse rather than lose a file.
    if (f.name in record) throw new Error(`duplicate entry name: '${f.name}' — every file in an archive needs a unique name.`)
    record[f.name] = f.data
  }
  return zipSync(record, { level: 6 })
}

const UNZIP_STREAM_CHUNK = 65_536

/**
 * unzipSync with the same MAX_ENTRIES/MAX_UNPACK_BYTES bomb guard — every zip-reading callsite must route through
 * this rather than calling unzipSync directly.
 *
 * A zip entry's declared `originalSize` is attacker-controlled (read straight off the header) and is not the actual
 * number of bytes fflate produces when it inflates the entry — a crafted zip can declare a tiny size while its
 * deflate stream expands to hundreds of MB. So the byte cap is enforced against *actual* decompressed output,
 * streamed through fflate's incremental Unzip/UnzipInflate (mirroring gunzipCapped's real-byte counting) rather than
 * trusting the header's declared value. unzipSync still runs first with every entry filtered out, purely to get its
 * zip-structure validation (throws on malformed/non-zip input, matching prior behavior) and an entry-count guard
 * before any inflation happens; the streaming pass re-checks MAX_ENTRIES too, since local-header entries (what the
 * streaming pass sees) and central-directory entries (what unzipSync's filter sees) can be crafted to disagree.
 */
function unzipGuarded(bytes: Uint8Array): Record<string, Uint8Array> {
  let declaredCount = 0
  unzipSync(bytes, {
    filter() {
      if (++declaredCount > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
      return false
    },
  })

  // Object.create(null): files[file.name] = ... on a plain {} silently
  // repoints its prototype for name === '__proto__' instead of creating an
  // own property, so Object.entries would drop that entry with no error and
  // no exception — unlike zipCreate's packing side, this assignment is on our
  // own object rather than routed through fflate's zipSync, so the
  // null-prototype fix fully resolves it here (a file named '__proto__'
  // extracts correctly instead of vanishing).
  const files: Record<string, Uint8Array> = Object.create(null)
  let count = 0
  let total = 0
  const unzipper = new Unzip((file) => {
    if (++count > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
    const chunks: Uint8Array[] = []
    let entryTotal = 0
    file.ondata = (err, chunk, final) => {
      if (err) throw err
      total += chunk.length
      entryTotal += chunk.length
      if (total > MAX_UNPACK_BYTES) throw new Error(`archive decompresses to more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
      chunks.push(chunk)
      if (final) {
        const out = new Uint8Array(entryTotal)
        let off = 0
        for (const c of chunks) {
          out.set(c, off)
          off += c.length
        }
        files[file.name] = out
      }
    }
    file.start()
  })
  unzipper.register(UnzipInflate)
  unzipper.register(UnzipPassThrough)
  for (let i = 0; i < bytes.length; i += UNZIP_STREAM_CHUNK) {
    unzipper.push(bytes.subarray(i, i + UNZIP_STREAM_CHUNK), i + UNZIP_STREAM_CHUNK >= bytes.length)
  }
  return files
}

export function zipExtract(bytes: Uint8Array): UnpackedEntry[] {
  const files = unzipGuarded(bytes)
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

/**
 * Validate a USTAR header block's checksum (offset 148-155): every valid tar
 * header stores the unsigned byte-sum of the whole 512-byte block, computed
 * with the checksum field itself treated as 8 ASCII spaces (mirroring
 * tarHeader's own computation above). Malformed/non-tar input essentially
 * never produces a byte run whose stored value happens to match this sum, so
 * this is a cheap, reliable "is this actually a tar header" gate — see
 * CLAUDE.md's fflate gotcha note on the same asymmetry for zip vs tar input
 * validation (tarExtract previously had none at all).
 */
function headerChecksumValid(header: Uint8Array): boolean {
  const stored = readOctal(header.subarray(148, 156))
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  return sum === stored
}

function tarHeader(name: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const nameBytes = strToU8(name.slice(0, 100))
  h.set(nameBytes, 0)
  h.set(writeOctal(0o644, 8), 100) // mode
  h.set(writeOctal(0, 8), 108) // uid
  h.set(writeOctal(0, 8), 116) // gid
  h.set(writeOctal(size, 12), 124) // size
  h.set(writeOctal(Math.max(0, Math.floor(mtime)), 12), 136) // mtime
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
    const header = tarHeader(f.name, f.data.length, f.mtime ?? 0)
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
    if (!headerChecksumValid(header)) throw new Error(`malformed/not a tar archive: invalid header checksum at offset ${off}.`)
    const nameBytes = header.subarray(0, 100)
    const nameEnd = nameBytes.indexOf(0)
    const name = strFromU8(nameEnd === -1 ? nameBytes : nameBytes.subarray(0, nameEnd))
    const size = readOctal(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] || 0)
    off += BLOCK

    if (++count > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries (bomb guard).`)
    declared += size
    if (declared > MAX_UNPACK_BYTES) throw new Error(`archive decompresses to more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
    if (off + size > bytes.length) throw new Error(`malformed/truncated tar: entry '${name}' declares ${size} bytes past the end of the archive.`)

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

/**
 * Unified extract result. `skipped` is only ever populated for 'tar' (dropped
 * symlinks/hardlinks/devices — see TarExtractResult) and omitted otherwise, so
 * callers can tell a tar extraction was partial without every format having
 * to carry a meaningless empty array.
 */
export type ArchiveExtractResult = { entries: UnpackedEntry[]; skipped?: Array<{ name: string; typeflag: string }> }

export function archiveExtract(format: ArchiveFormat, bytes: Uint8Array): ArchiveExtractResult {
  switch (format) {
    case 'zip':
      return { entries: zipExtract(bytes) }
    case 'tar': {
      const { entries, skipped } = tarExtract(bytes)
      return skipped.length ? { entries, skipped } : { entries }
    }
    case 'gzip':
      return { entries: [gzipExtract(bytes)] }
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
  const files = unzipGuarded(bytes)
  return Promise.all(
    Object.entries(files).map(([name, data]) =>
      putBytes(caps.store, data, name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
    ),
  )
}
