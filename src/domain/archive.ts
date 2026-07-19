// Archive create/extract: zip, gzip, tar. Pure functions — no I/O, no fetch,
// no filesystem access of their own (safeExtractPath resolves paths but never
// touches the filesystem — that's left to a caller/adapter). Ported from
// sux-fileops's src/core/archive.ts (itself adapted from sux's src/fns/archive.ts)
// during the suxlib absorption of sux-fileops.

import { Gunzip, Unzip, UnzipInflate, UnzipPassThrough, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import type { LeafFn } from '../op/types.js'
import type { Handle } from '../effects/types.js'
import { resolve, putBytes } from '../handles/handle.js'

/** Cap total decompressed output so a zip/gzip bomb can't OOM the process. */
export const MAX_UNPACK_BYTES = 20_000_000
/** Cap entry count so a many-file archive can't exhaust memory. */
export const MAX_ENTRIES = 2_000
/** Don't inline megabytes of decoded text per entry. */
export const MAX_TEXT = 100_000

export type ArchiveFile = { name: string; data: Uint8Array; mtime?: number }
export type UnpackedEntry = { name: string; bytes: number; text?: string; truncated?: boolean; data: Uint8Array; mtime?: number }

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

function decodeEntry(name: string, data: Uint8Array, mtime?: number): UnpackedEntry {
  const e: UnpackedEntry = { name, bytes: data.length, data }
  if (mtime !== undefined) e.mtime = mtime
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

// DOS date/time (the format zip headers embed mtime in) can't represent
// anything before 1980, so unlike tarCreate's mtime ?? 0 (a plain Unix
// timestamp, epoch 0 is valid) zipCreate can't default a missing mtime to 0
// — fflate throws 'date not in range 1980-2099'. Default to the earliest
// representable DOS date instead, keeping output deterministic without a caller-supplied mtime.
// fflate's zip writer reads the DOS year via local (not UTC) Date getters, so this must be
// built with the local Date constructor — Date.UTC(1980, 0, 1) reads back as 1979 in any
// timezone behind UTC, tripping fflate's own 'date not in range 1980-2099' guard. Computed
// fresh per call (not a module-level constant) so it tracks the process's current TZ rather
// than whatever TZ happened to be active at import time.
const zipEpoch = () => new Date(1980, 0, 1).getTime()

/**
 * DOS date/time's 7-bit year field can only represent 1980-2099 (see zipEpoch
 * above); fflate's zipSync writes it via local, not UTC, Date getters, so the
 * bound is checked the same way here. zipCreate previously only substituted
 * zipEpoch() for a missing mtime (`f.mtime ?? zipEpoch()`) — an *explicit*
 * out-of-range mtime (e.g. one decoded from a tar/gzip entry, whose formats
 * have no such bound) fell straight through to fflate's own internal
 * 'date not in range 1980-2099' throw. Reject with a clear domain-style error
 * instead of letting that leak through uncaught.
 */
function assertZipMtimeInRange(name: string, mtime: number): void {
  const year = new Date(mtime).getFullYear()
  if (year < 1980 || year > 2099) {
    throw new Error(`file '${name}' has an mtime (year ${year}) outside the range zip's DOS date format can represent (1980-2099).`)
  }
}

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
  const record: Record<string, [Uint8Array, { mtime: number }]> = Object.create(null)
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
    // fflate defaults a missing mtime to Date.now(), making zipCreate's output
    // wall-clock-dependent even for byte-identical input; default to
    // zipEpoch() unless the caller supplied one.
    if (f.mtime !== undefined) assertZipMtimeInRange(f.name, f.mtime)
    record[f.name] = [f.data, { mtime: f.mtime ?? zipEpoch() }]
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

function readU16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8)
}

function readU32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
}

function readU64(d: Uint8Array, o: number): number {
  return readU32(d, o) + readU32(d, o + 4) * 0x1_0000_0000
}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50

/**
 * Decode each entry's DOS date/time out of the zip central directory. Neither
 * unzipSync nor the streaming Unzip class surface mtime through fflate's
 * public API (UnzipFileInfo only carries name/size/compression), so this walks
 * the central directory the same way fflate's internal zh() does — read-only,
 * no decompression — to recover the field zipCreate writes (see zipEpoch
 * above). Best-effort: an EOCD record that can't be found (corrupt/exotic
 * input already rejected by unzipGuarded's unzipSync validation pass) just
 * yields no mtimes rather than throwing a second time.
 *
 * When an archive has >65535 entries or a >4GB central directory, the plain
 * EOCD's count/offset fields are the sentinel 0xffff/0xffffffff and the real
 * values live in the zip64 end-of-central-directory record, reached via the
 * zip64 EOCD locator (signature 0x07064b50) that immediately precedes the
 * plain EOCD — mirrors fflate's own z64hs() so mtimes stay correct once
 * MAX_ENTRIES/MAX_UNPACK_BYTES are ever raised past those thresholds.
 */
function readZipMtimes(bytes: Uint8Array): Record<string, number> {
  const mtimes: Record<string, number> = Object.create(null)
  let e = bytes.length - 22
  for (; e >= 0 && readU32(bytes, e) !== EOCD_SIGNATURE; e--) {
    if (bytes.length - e > 65558) return mtimes
  }
  if (e < 0) return mtimes
  let count = readU16(bytes, e + 8)
  let o = readU32(bytes, e + 16)
  const locatorOff = e - 20
  if ((count === 0xffff || o === 0xffffffff) && locatorOff >= 0 && readU32(bytes, locatorOff) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    const z64Off = readU64(bytes, locatorOff + 8)
    if (z64Off >= 0 && z64Off + 56 <= bytes.length && readU32(bytes, z64Off) === ZIP64_EOCD_SIGNATURE) {
      count = readU64(bytes, z64Off + 32)
      o = readU64(bytes, z64Off + 48)
    }
  }
  for (let i = 0; i < count && o + 46 <= bytes.length; i++) {
    const modTime = readU16(bytes, o + 12)
    const modDate = readU16(bytes, o + 14)
    const fnl = readU16(bytes, o + 28)
    const efl = readU16(bytes, o + 30)
    const cml = readU16(bytes, o + 32)
    const name = strFromU8(bytes.subarray(o + 46, o + 46 + fnl))
    const year = ((modDate >> 9) & 0x7f) + 1980
    const month = (modDate >> 5) & 0xf
    const day = modDate & 0x1f
    const hours = (modTime >> 11) & 0x1f
    const minutes = (modTime >> 5) & 0x3f
    const seconds = (modTime & 0x1f) * 2
    mtimes[name] = new Date(year, month - 1, day, hours, minutes, seconds).getTime()
    o += 46 + fnl + efl + cml
  }
  return mtimes
}

export function zipExtract(bytes: Uint8Array): UnpackedEntry[] {
  const files = unzipGuarded(bytes)
  const mtimes = readZipMtimes(bytes)
  return Object.entries(files).map(([name, data]) => decodeEntry(name, data, mtimes[name]))
}

// ---------- gzip ----------

export function gzipCreate(data: Uint8Array, mtime = 0): Uint8Array {
  if (data.length > MAX_UNPACK_BYTES) throw new Error(`archive input totals more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
  // fflate only omits the header's wall-clock MTIME when mtime is exactly 0
  // (any other value, including undefined, embeds Date.now()) — default to 0
  // so gzipCreate(tarCreate(files)) stays fully deterministic end to end.
  return gzipSync(data, { level: 6, mtime })
}

export function gzipExtract(bytes: Uint8Array): UnpackedEntry {
  const data = gunzipCapped(bytes)
  // Gzip's header MTIME (RFC 1952 §2.3.1) is a 4-byte LE Unix-seconds field at
  // offset 4; gzipCreate's mtime:0 default means "omitted" (see its comment),
  // so a zero field surfaces as no mtime rather than the epoch.
  const mtimeSecs = bytes.length >= 8 ? readU32(bytes, 4) : 0
  return decodeEntry('data', data, mtimeSecs > 0 ? mtimeSecs * 1000 : undefined)
}

// ---------- tar (USTAR, uncompressed) ----------
// Minimal pure-JS tar reader/writer. No compression of its own — the
// 'tar.gz' ArchiveFormat below composes this with gzip above
// (gzipCreate(tarCreate(files)) / tarExtract(gunzipCapped(bytes))).

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
  h.set(writeOctal(Math.max(0, Math.floor(mtime / 1000)), 12), 136) // mtime (Unix seconds, not ms)
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
    const mtime = readOctal(header.subarray(136, 148)) * 1000 // header stores Unix seconds; ArchiveFile.mtime is ms
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
      entries.push(decodeEntry(name, new Uint8Array(data), mtime))
    } else {
      skipped.push({ name, typeflag })
    }
  }
  return { entries, skipped }
}

// ---------- unified entry points ----------

export const ARCHIVE_FORMATS = ['zip', 'gzip', 'tar', 'tar.gz'] as const
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
    case 'tar.gz':
      return gzipCreate(tarCreate(files))
    case 'gzip':
      if (files.length !== 1) throw new Error(`gzip packs exactly one file — got ${files.length}. Use format='zip' or 'tar' for multiple.`)
      return gzipCreate(files[0].data, files[0].mtime ?? 0)
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
    case 'tar.gz': {
      const { entries, skipped } = tarExtract(gunzipCapped(bytes))
      return skipped.length ? { entries, skipped } : { entries }
    }
    case 'gzip':
      return { entries: [gzipExtract(bytes)] }
  }
}

// 'tar.gz' and 'gzip' share 'application/gzip' -- gzip is a byte-stream codec
// with no format-level tar marker, so there's no MIME value that distinguishes
// a tar bundle piped through gzip from a single gzip'd file. Don't add a
// MIME-based format auto-detection path against this map; a caller's own
// format tag (as CLI's inferArchiveFormat already uses, off the filename
// extension) is the only reliable signal -- distinguishing the two from bytes
// alone needs peeking the decompressed stream for a valid tar header.
export const ARCHIVE_MIME: Record<ArchiveFormat, string> = {
  zip: 'application/zip',
  gzip: 'application/gzip',
  tar: 'application/x-tar',
  'tar.gz': 'application/gzip',
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

// pack/unpack: Handle-based wrappers around archiveCreate/archiveExtract, for
// an op tree that wants to build or open zip/tar/gzip archives (any format,
// unlike unzip above which is zip-only and kept as-is since the sux Worker's
// tracer-bullet op tree already depends on its exact signature).
export type PackInput = { format: ArchiveFormat; files: Array<{ name: string; handle: Handle; mtime?: number }> }
export const pack: LeafFn = async (input, caps) => {
  const { format, files } = input as PackInput
  const resolved = await Promise.all(
    files.map(async (f) => ({ name: f.name, data: await resolve(caps.store, f.handle), mtime: f.mtime })),
  )
  const bytes = archiveCreate(format, resolved)
  return putBytes(caps.store, bytes, ARCHIVE_MIME[format])
}

export type UnpackInput = { format: ArchiveFormat; handle: Handle }
export const unpack: LeafFn = async (input, caps) => {
  const { format, handle } = input as UnpackInput
  const bytes = await resolve(caps.store, handle)
  const { entries, skipped } = archiveExtract(format, bytes)
  const parts = await Promise.all(
    entries.map(async (e) => ({ name: e.name, handle: await putBytes(caps.store, e.data, 'application/octet-stream'), mtime: e.mtime })),
  )
  return skipped ? { entries: parts, skipped } : { entries: parts }
}
