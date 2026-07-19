import { test, expect } from 'vitest'
import { zipSync, gzipSync, strToU8 } from 'fflate'
import { crc32 } from 'node:zlib'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolve, resolveText } from '../../src/handles/handle.js'
import {
  unzip,
  pack,
  unpack,
  zipCreate,
  zipExtract,
  gzipCreate,
  gzipExtract,
  tarCreate,
  tarExtract,
  archiveCreate,
  archiveExtract,
  safeExtractPath,
  ARCHIVE_MIME,
} from '../../src/domain/archive.js'

test('unzip expands a zip handle into per-file handles', async () => {
  const store = new MemoryStore()
  const zip = zipSync({ 'a.txt': strToU8('AAA'), 'b.txt': strToU8('BBB') })
  const zh = await putBytes(store, zip, 'application/zip')
  const parts = await unzip(zh, { store } as any)
  expect(parts.length).toBe(2)
  expect((await Promise.all(parts.map((p: any) => resolveText(store, p)))).sort()).toEqual(['AAA', 'BBB'])
})

test('zipCreate/zipExtract round-trips text and binary entries', () => {
  const bin = new Uint8Array([0, 1, 2, 255])
  const packed = zipCreate([
    { name: 'hello.txt', data: strToU8('hello world') },
    { name: 'raw.bin', data: bin },
  ])
  const entries = zipExtract(packed)
  const names = entries.map((e) => e.name).sort()
  expect(names).toEqual(['hello.txt', 'raw.bin'])
  const txt = entries.find((e) => e.name === 'hello.txt')!
  expect(txt.text).toBe('hello world')
  const raw = entries.find((e) => e.name === 'raw.bin')!
  expect(raw.text).toBeUndefined()
})

test('zipCreate is deterministic — two calls with identical input produce byte-identical output', async () => {
  const files = [{ name: 'hello.txt', data: strToU8('hello world') }]
  const first = zipCreate(files)
  await new Promise((r) => setTimeout(r, 5))
  const second = zipCreate(files)
  expect(second).toEqual(first)
})

test('zipCreate with no mtime does not throw in a timezone behind UTC', () => {
  const prevTz = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    expect(() => zipCreate([{ name: 'a.txt', data: strToU8('AAA') }])).not.toThrow()
  } finally {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  }
})

test('zipCreate rejects duplicate entry names instead of silently dropping one', () => {
  expect(() => zipCreate([{ name: 'a', data: strToU8('1') }, { name: 'a', data: strToU8('2') }])).toThrow(/duplicate entry name/)
})

test('zipCreate does not falsely flag a name inherited from Object.prototype (e.g. "constructor") as a duplicate', () => {
  const packed = zipCreate([{ name: 'constructor', data: strToU8('not a duplicate') }])
  expect(zipExtract(packed).map((e) => e.name)).toEqual(['constructor'])
})

test('zipCreate rejects a file literally named __proto__ with a clear error instead of crashing inside fflate', () => {
  // fflate's own zipSync corrupts its internal state for this exact name (see
  // src/domain/archive.ts's comment on zipCreate) — refusing up front avoids
  // both the previous false "duplicate entry name" report and a confusing
  // TypeError from deep inside the dependency.
  expect(() => zipCreate([{ name: '__proto__', data: strToU8('x') }])).toThrow(/__proto__/)
})

/** Build a minimal single-entry STORED zip by hand, bypassing fflate's zipSync (which can't produce an entry named '__proto__' at all — see zipCreate's guard). */
function buildStoredZip(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = strToU8(name)
  const crc = crc32(Buffer.from(data)) >>> 0
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff])
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff])
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out
  }
  const localHeader = concat(
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
    u32(crc), u32(data.length), u32(data.length),
    u16(nameBytes.length), u16(0),
    nameBytes,
  )
  const centralHeader = concat(
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
    u32(crc), u32(data.length), u32(data.length),
    u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
    u32(0), u32(0),
    nameBytes,
  )
  const cdOffset = localHeader.length + data.length
  const eocd = concat(u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(centralHeader.length), u32(cdOffset), u16(0))
  return concat(localHeader, data, centralHeader, eocd)
}

test('zipExtract correctly extracts an attacker-crafted zip entry literally named __proto__ instead of silently losing it', () => {
  const zipBytes = buildStoredZip('__proto__', strToU8('proto payload'))
  const entries = zipExtract(zipBytes)
  expect(entries.map((e) => e.name)).toEqual(['__proto__'])
  expect(entries[0].text).toBe('proto payload')
  expect(Object.getPrototypeOf({})).toBe(Object.prototype) // extraction didn't leak into Object.prototype
})

test('zipExtract extracts STORED (uncompressed) entries, not just DEFLATE ones', () => {
  const zip = zipSync({ 'stored.txt': strToU8('stored, not deflated') }, { level: 0 })
  const entries = zipExtract(zip)
  expect(entries.map((e) => e.name)).toEqual(['stored.txt'])
  expect(entries[0].text).toBe('stored, not deflated')
})

test('gzipCreate/gzipExtract round-trips a single file', () => {
  const packed = gzipCreate(strToU8('gzip me '.repeat(50)))
  const out = gzipExtract(packed)
  expect(out.text).toBe('gzip me '.repeat(50))
})

test('gzipCreate is deterministic — two calls with identical input produce byte-identical output, including gzipCreate(tarCreate(...))', async () => {
  const data = strToU8('gzip me '.repeat(50))
  const first = gzipCreate(data)
  await new Promise((r) => setTimeout(r, 5))
  const second = gzipCreate(data)
  expect(second).toEqual(first)

  const files = [{ name: 'a.txt', data: strToU8('AAA') }]
  const firstTgz = gzipCreate(tarCreate(files))
  await new Promise((r) => setTimeout(r, 5))
  const secondTgz = gzipCreate(tarCreate(files))
  expect(secondTgz).toEqual(firstTgz)
})

test('archiveCreate honors an explicit per-file mtime for the gzip format instead of always defaulting to epoch 0', () => {
  const data = strToU8('AAA')
  const viaArchiveCreate = archiveCreate('gzip', [{ name: 'a.txt', data, mtime: 12345 }])
  const viaGzipCreate = gzipCreate(data, 12345)
  expect(viaArchiveCreate).toEqual(viaGzipCreate)
  expect(viaArchiveCreate).not.toEqual(gzipCreate(data, 0))
})

test('tarCreate/tarExtract round-trips multiple files and reports skipped non-regular entries', () => {
  const packed = tarCreate([
    { name: 'a.txt', data: strToU8('AAA') },
    { name: 'b.txt', data: strToU8('BBB') },
  ])
  const { entries, skipped } = tarExtract(packed)
  expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt'])
  expect(skipped).toEqual([])
})

test('tarCreate is deterministic for identical input instead of embedding wall-clock mtime', () => {
  const files = [{ name: 'a.txt', data: strToU8('AAA') }]
  expect(tarCreate(files)).toEqual(tarCreate(files))
})

test('tarCreate honors an explicit per-file mtime instead of always defaulting to epoch 0', () => {
  const mtime = 1_700_000_000_000
  const packed = tarCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])
  const header = packed.subarray(0, 512)
  const octal = new TextDecoder().decode(header.subarray(136, 148)).replace(/\0.*$/, '').trim()
  expect(parseInt(octal, 8)).toBe(Math.floor(mtime / 1000))
})

test('zipCreate/zipExtract round-trips an explicit per-file mtime', () => {
  const mtime = new Date(2022, 4, 17, 10, 30, 0).getTime() // May has DOS-representable 2-second resolution
  const packed = zipCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])
  const entry = zipExtract(packed).find((e) => e.name === 'a.txt')!
  expect(entry.mtime).toBe(mtime)
})

test('zipCreate rejects an explicit mtime before 1980 with a clear error instead of leaking fflate\'s internal throw', () => {
  const mtime = new Date(1970, 0, 1).getTime()
  expect(() => zipCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])).toThrow(/1980-2099/)
})

test('zipCreate rejects an explicit mtime after 2099 with a clear error instead of leaking fflate\'s internal throw', () => {
  const mtime = new Date(2100, 0, 1).getTime()
  expect(() => zipCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])).toThrow(/1980-2099/)
})

test('zipExtract recovers mtime from the zip64 end-of-central-directory record when the plain EOCD fields are the zip64 sentinel', () => {
  const mtime = new Date(2022, 4, 17, 10, 30, 0).getTime()
  const packed = zipCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])

  const eocdOff = packed.length - 22
  const centralDirOffset = (packed[eocdOff + 16] | (packed[eocdOff + 17] << 8) | (packed[eocdOff + 18] << 16) | (packed[eocdOff + 19] << 24)) >>> 0
  const centralDirSize = eocdOff - centralDirOffset
  const prefix = packed.subarray(0, eocdOff)
  const z64EocdOffset = prefix.length

  const writeU32 = (buf: Uint8Array, o: number, v: number) => {
    buf[o] = v & 0xff
    buf[o + 1] = (v >>> 8) & 0xff
    buf[o + 2] = (v >>> 16) & 0xff
    buf[o + 3] = (v >>> 24) & 0xff
  }
  const writeU64 = (buf: Uint8Array, o: number, v: number) => {
    writeU32(buf, o, v >>> 0)
    writeU32(buf, o + 4, 0)
  }

  const z64Record = new Uint8Array(56)
  writeU32(z64Record, 0, 0x06064b50)
  writeU64(z64Record, 4, 44)
  z64Record[12] = 45 // version made by
  z64Record[14] = 45 // version needed
  writeU64(z64Record, 24, 1) // total entries, this disk
  writeU64(z64Record, 32, 1) // total entries
  writeU64(z64Record, 40, centralDirSize)
  writeU64(z64Record, 48, centralDirOffset)

  const locator = new Uint8Array(20)
  writeU32(locator, 0, 0x07064b50)
  writeU64(locator, 8, z64EocdOffset)
  writeU32(locator, 16, 1) // total number of disks

  const eocd = new Uint8Array(22)
  writeU32(eocd, 0, 0x06054b50)
  eocd[8] = 0xff
  eocd[9] = 0xff // sentinel entry count -> defer to zip64 record
  eocd[10] = 0xff
  eocd[11] = 0xff
  writeU32(eocd, 16, 0xffffffff) // sentinel central-dir offset -> defer to zip64 record

  const zip64Bytes = new Uint8Array(prefix.length + z64Record.length + locator.length + eocd.length)
  zip64Bytes.set(prefix, 0)
  zip64Bytes.set(z64Record, prefix.length)
  zip64Bytes.set(locator, prefix.length + z64Record.length)
  zip64Bytes.set(eocd, prefix.length + z64Record.length + locator.length)

  const entry = zipExtract(zip64Bytes).find((e) => e.name === 'a.txt')!
  expect(entry.mtime).toBe(mtime)
})

test('gzipCreate/gzipExtract round-trips an explicit mtime, and omits it when not supplied', () => {
  const mtime = 1_700_000_000_000
  const packed = gzipCreate(strToU8('hi'), mtime)
  expect(gzipExtract(packed).mtime).toBe(Math.floor(mtime / 1000) * 1000)

  const noMtime = gzipCreate(strToU8('hi'))
  expect(gzipExtract(noMtime).mtime).toBeUndefined()
})

test('tarCreate/tarExtract round-trips an explicit per-file mtime, including 0', () => {
  const mtime = 1_700_000_000_000
  const packed = tarCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])
  const { entries } = tarExtract(packed)
  expect(entries[0].mtime).toBe(Math.floor(mtime / 1000) * 1000)

  const zeroed = tarCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime: 0 }])
  expect(tarExtract(zeroed).entries[0].mtime).toBe(0)
})

test('tarExtract throws on a truncated entry instead of silently returning a short file', () => {
  const packed = tarCreate([{ name: 'a.txt', data: strToU8('AAAAAAAAAA') }])
  const truncated = packed.subarray(0, 512 + 5) // header intact, only 5 of the declared 10 data bytes present
  expect(() => tarExtract(truncated)).toThrow(/malformed\/truncated tar/)
})

test('pack/unpack round-trip files through Handles, for any archive format', async () => {
  const store = new MemoryStore()
  for (const format of ['zip', 'tar'] as const) {
    const ha = await putBytes(store, strToU8('AAA'), 'text/plain')
    const hb = await putBytes(store, strToU8('BBB'), 'text/plain')
    const archiveHandle = await pack({ format, files: [{ name: 'a.txt', handle: ha }, { name: 'b.txt', handle: hb }] }, { store } as any)
    const { entries } = await unpack({ format, handle: archiveHandle }, { store } as any)
    expect(entries.length).toBe(2)
    const texts = await Promise.all(entries.map((e: any) => resolveText(store, e.handle)))
    expect(texts.sort()).toEqual(['AAA', 'BBB'])
  }
})

test('unpack surfaces each entry mtime on the LeafFn result, not just archiveExtract', async () => {
  const store = new MemoryStore()
  const mtime = 1_700_000_000_000
  const packed = tarCreate([{ name: 'a.txt', data: strToU8('AAA'), mtime }])
  const archiveHandle = await putBytes(store, packed, 'application/x-tar')
  const { entries } = await unpack({ format: 'tar', handle: archiveHandle }, { store } as any)
  expect(entries[0].mtime).toBe(Math.floor(mtime / 1000) * 1000)
})

test('pack honors an explicit per-file mtime for the gzip format (threaded through to archiveCreate)', async () => {
  const store = new MemoryStore()
  const h = await putBytes(store, strToU8('AAA'), 'text/plain')
  const archiveHandle = await pack({ format: 'gzip', files: [{ name: 'a.txt', handle: h, mtime: 12345 }] }, { store } as any)
  const bytes = await resolve(store, archiveHandle)
  expect(bytes).toEqual(gzipCreate(strToU8('AAA'), 12345))
})

test('archiveCreate/archiveExtract dispatch by format, and ARCHIVE_MIME covers every format', () => {
  for (const format of ['zip', 'tar', 'tar.gz'] as const) {
    const packed = archiveCreate(format, [{ name: 'x', data: strToU8('X') }])
    expect(archiveExtract(format, packed).entries[0].text).toBe('X')
    expect(ARCHIVE_MIME[format]).toBeTruthy()
  }
  const gz = archiveCreate('gzip', [{ name: 'x', data: strToU8('X') }])
  expect(archiveExtract('gzip', gz).entries[0].text).toBe('X')
})

test('tar.gz round-trips multiple files through gzipCreate(tarCreate(files))', () => {
  const files = [
    { name: 'a.txt', data: strToU8('AAA'), mtime: 12345000 },
    { name: 'b.txt', data: strToU8('BBB'), mtime: 67890000 },
  ]
  const packed = archiveCreate('tar.gz', files)
  expect(packed).toEqual(gzipCreate(tarCreate(files)))
  const { entries } = archiveExtract('tar.gz', packed)
  expect(entries.map((e) => [e.name, e.text, e.mtime])).toEqual([
    ['a.txt', 'AAA', 12345000],
    ['b.txt', 'BBB', 67890000],
  ])
})

test('archiveExtract surfaces tarExtract\'s skipped info for tar.gz too, not just plain tar', () => {
  const tarWithSymlink = buildRawTarEntry('evil-link', '2')
  const gz = gzipCreate(tarWithSymlink)
  const result = archiveExtract('tar.gz', gz)
  expect(result.entries).toEqual([])
  expect(result.skipped).toEqual([{ name: 'evil-link', typeflag: '2' }])
})

const BLOCK = 512

/** Build a minimal single-entry USTAR tar with an arbitrary typeflag and a valid header checksum. */
function buildRawTarEntry(name: string, typeflag: string): Uint8Array {
  const header = new Uint8Array(BLOCK)
  header.set(strToU8(name.slice(0, 100)), 0)
  header.set(strToU8('0000000000\0'), 124) // size octal: 0
  header[156] = typeflag.charCodeAt(0)
  header.set(strToU8('        '), 148) // checksum placeholder (8 spaces), like tarHeader
  let checksum = 0
  for (let i = 0; i < BLOCK; i++) checksum += header[i]
  header.set(strToU8(checksum.toString(8).padStart(7, '0') + '\0'), 148)
  const footer = new Uint8Array(BLOCK * 2)
  const out = new Uint8Array(header.length + footer.length)
  out.set(header, 0)
  out.set(footer, header.length)
  return out
}

test('tarExtract throws on malformed non-tar input instead of silently returning a garbage result', () => {
  const garbage = new Uint8Array(1024)
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) % 256
  expect(() => tarExtract(garbage)).toThrow(/malformed\/not a tar archive/)
})

test('archiveExtract surfaces tarExtract\'s skipped (dropped symlink) info instead of discarding it', () => {
  const tarWithSymlink = buildRawTarEntry('evil-link', '2') // typeflag '2' = symlink
  const result = archiveExtract('tar', tarWithSymlink)
  expect(result.entries).toEqual([])
  expect(result.skipped).toEqual([{ name: 'evil-link', typeflag: '2' }])
})

test('archiveExtract omits `skipped` entirely for zip/gzip and for a fully-regular tar', () => {
  const packed = archiveCreate('tar', [{ name: 'x', data: strToU8('X') }])
  expect(archiveExtract('tar', packed).skipped).toBeUndefined()
  const zipped = archiveCreate('zip', [{ name: 'x', data: strToU8('X') }])
  expect(archiveExtract('zip', zipped).skipped).toBeUndefined()
})

test('archiveCreate rejects gzip with more than one file', () => {
  expect(() => archiveCreate('gzip', [{ name: 'a', data: strToU8('1') }, { name: 'b', data: strToU8('2') }])).toThrow(/exactly one file/)
})

test('zipExtract fails a zip bomb whose declared entry size exceeds the cap', () => {
  const bomb = zipSync({ 'big.bin': new Uint8Array(21_000_000) }, { level: 9 })
  expect(() => zipExtract(bomb)).toThrow(/bomb guard/)
})

test('unzip leaf fails a zip bomb whose declared entry size exceeds the cap', async () => {
  const store = new MemoryStore()
  const bomb = zipSync({ 'big.bin': new Uint8Array(21_000_000) }, { level: 9 })
  const zh = await putBytes(store, bomb, 'application/zip')
  await expect(unzip(zh, { store } as any)).rejects.toThrow(/bomb guard/)
})

test('gzipExtract fails a gzip bomb instead of decompressing it fully', () => {
  const bomb = gzipSync(new Uint8Array(21_000_000), { level: 9 })
  expect(() => gzipExtract(bomb)).toThrow(/bomb guard/)
})

/** Overwrite the 4-byte uncompressed-size field following every occurrence of a zip record signature. */
function patchDeclaredSize(zip: Uint8Array, signature: number[], sizeOffset: number, declaredSize: number): void {
  for (let i = 0; i < zip.length - 4; i++) {
    if (signature.every((b, j) => zip[i + j] === b)) {
      new DataView(zip.buffer, zip.byteOffset + i + sizeOffset, 4).setUint32(0, declaredSize, true)
    }
  }
}

test('zipExtract fails a zip bomb that lies about its declared entry size (originalSize is attacker-controlled)', () => {
  const real = zipSync({ 'big.bin': new Uint8Array(21_000_000).fill(65) }, { level: 9 })
  const tampered = new Uint8Array(real)
  patchDeclaredSize(tampered, [0x50, 0x4b, 0x03, 0x04], 22, 10) // local file header uncompressed size
  patchDeclaredSize(tampered, [0x50, 0x4b, 0x01, 0x02], 24, 10) // central directory uncompressed size
  expect(() => zipExtract(tampered)).toThrow(/bomb guard/)
})

test('safeExtractPath rejects absolute paths and directory escapes (zip-slip guard)', () => {
  expect(() => safeExtractPath('/tmp/out', '/etc/passwd')).toThrow(/absolute path/)
  expect(() => safeExtractPath('/tmp/out', '../../etc/passwd')).toThrow(/escapes the extraction directory/)
  expect(safeExtractPath('/tmp/out', 'a/b.txt')).toBe('/tmp/out/a/b.txt')
})
