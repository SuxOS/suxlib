import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { archiveCreate } from '../../src/domain/archive.js'
import { extractArchiveTo, main, transform } from '../../src/adapters/cli.js'

// extractArchiveTo exercises the CLI's actual filesystem-writing extract path —
// the real attack surface the zip-slip guard protects, as opposed to
// domain/archive.test.ts which only exercises the pure parse/decode step.

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'suxlib-fileops-extract-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('transform (re-export of dispatchTransform)', () => {
  it('is callable directly without triggering argv parsing', () => {
    expect(transform('{"a":1}', 'json', 'yaml')).toBe('a: 1')
  })
})

describe('extractArchiveTo (CLI filesystem extract path)', () => {
  it('writes entries under the output directory on a well-formed archive', () => {
    const out = tmpDir()
    const packed = archiveCreate('zip', [{ name: 'a.txt', data: new TextEncoder().encode('hello') }])
    const { written, skipped } = extractArchiveTo('zip', packed, out)
    expect(written).toBe(1)
    expect(skipped).toEqual([])
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hello')
  })

  it("restores an entry's mtime on the extracted file via utimesSync", () => {
    const out = tmpDir()
    const mtime = new Date(2022, 4, 17, 10, 30, 0).getTime()
    const packed = archiveCreate('zip', [{ name: 'a.txt', data: new TextEncoder().encode('hello'), mtime }])
    extractArchiveTo('zip', packed, out)
    expect(statSync(join(out, 'a.txt')).mtimeMs).toBeCloseTo(mtime, -3)
  })

  it('refuses to extract (and writes nothing outside the output dir) for a zip-slip entry name', () => {
    const out = tmpDir()
    const escapeTarget = resolve(out, '..', 'suxlib-fileops-zip-slip-victim.txt')
    rmSync(escapeTarget, { force: true })
    const packed = zipSync({ '../suxlib-fileops-zip-slip-victim.txt': new TextEncoder().encode('pwned') }, { level: 6 })
    expect(() => extractArchiveTo('zip', packed, out)).toThrow(/escapes|absolute/)
    expect(existsSync(escapeTarget)).toBe(false)
    rmSync(escapeTarget, { force: true })
  })
})

describe('cli `sanitize text` (real CLI entry point)', () => {
  it('rejects an invalid --types value instead of silently redacting nothing', async () => {
    const work = tmpDir()
    const inPath = join(work, 'in.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(inPath, 'contact me at a@b.com')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    await main(['node', 'suxlib-fileops', 'sanitize', 'text', inPath, '--types', 'emial'])
    expect(process.exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/--types must be/))
    process.exitCode = 0
    errSpy.mockRestore()
  })
})

describe('cli `archive create` (real CLI entry point)', () => {
  it('reports duplicate basenames cleanly and writes no output file', async () => {
    const work = tmpDir()
    const outPath = join(work, 'out.zip')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    // Two distinct source paths that share a basename after archiveCreate's
    // basename()-keyed naming — the CLI's `archive create` action itself
    // calls basename(f) per file, so passing the same literal path twice is
    // the simplest way to trigger a duplicate without touching disk twice.
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const dirA = join(work, 'a')
    const dirB = join(work, 'b')
    mkdirSync(dirA)
    mkdirSync(dirB)
    const fileA = join(dirA, 'same.txt')
    const fileB = join(dirB, 'same.txt')
    writeFileSync(fileA, 'first')
    writeFileSync(fileB, 'second')
    await main(['node', 'suxlib-fileops', 'archive', 'create', '-o', outPath, fileA, fileB])
    expect(process.exitCode).toBe(1)
    expect(existsSync(outPath)).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/duplicate/i))
    process.exitCode = 0
    errSpy.mockRestore()
  })

  it('honors an explicit --mtime override for every packed file', async () => {
    const work = tmpDir()
    const inPath = join(work, 'in.txt')
    const outPath = join(work, 'out.zip')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(inPath, 'hello')
    const mtime = new Date(2022, 4, 17, 10, 30, 0).getTime()
    await main(['node', 'suxlib-fileops', 'archive', 'create', '-o', outPath, '-m', String(mtime), inPath])
    const { archiveExtract } = await import('../../src/domain/archive.js')
    const entry = archiveExtract('zip', new Uint8Array(readFileSync(outPath))).entries.find((e) => e.name === 'in.txt')!
    expect(entry.mtime).toBe(mtime)
  })
})
