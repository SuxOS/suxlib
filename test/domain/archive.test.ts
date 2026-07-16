import { test, expect } from 'vitest'
import { zipSync, gzipSync, strToU8 } from 'fflate'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolveText } from '../../src/handles/handle.js'
import {
  unzip,
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

test('zipCreate rejects duplicate entry names instead of silently dropping one', () => {
  expect(() => zipCreate([{ name: 'a', data: strToU8('1') }, { name: 'a', data: strToU8('2') }])).toThrow(/duplicate entry name/)
})

test('gzipCreate/gzipExtract round-trips a single file', () => {
  const packed = gzipCreate(strToU8('gzip me '.repeat(50)))
  const out = gzipExtract(packed)
  expect(out.text).toBe('gzip me '.repeat(50))
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

test('archiveCreate/archiveExtract dispatch by format, and ARCHIVE_MIME covers every format', () => {
  for (const format of ['zip', 'tar'] as const) {
    const packed = archiveCreate(format, [{ name: 'x', data: strToU8('X') }])
    expect(archiveExtract(format, packed)[0].text).toBe('X')
    expect(ARCHIVE_MIME[format]).toBeTruthy()
  }
  const gz = archiveCreate('gzip', [{ name: 'x', data: strToU8('X') }])
  expect(archiveExtract('gzip', gz)[0].text).toBe('X')
})

test('archiveCreate rejects gzip with more than one file', () => {
  expect(() => archiveCreate('gzip', [{ name: 'a', data: strToU8('1') }, { name: 'b', data: strToU8('2') }])).toThrow(/exactly one file/)
})

test('zipExtract fails a zip bomb whose declared entry size exceeds the cap', () => {
  const bomb = zipSync({ 'big.bin': new Uint8Array(21_000_000) }, { level: 9 })
  expect(() => zipExtract(bomb)).toThrow(/bomb guard/)
})

test('gzipExtract fails a gzip bomb instead of decompressing it fully', () => {
  const bomb = gzipSync(new Uint8Array(21_000_000), { level: 9 })
  expect(() => gzipExtract(bomb)).toThrow(/bomb guard/)
})

test('safeExtractPath rejects absolute paths and directory escapes (zip-slip guard)', () => {
  expect(() => safeExtractPath('/tmp/out', '/etc/passwd')).toThrow(/absolute path/)
  expect(() => safeExtractPath('/tmp/out', '../../etc/passwd')).toThrow(/escapes the extraction directory/)
  expect(safeExtractPath('/tmp/out', 'a/b.txt')).toBe('/tmp/out/a/b.txt')
})
