import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { archiveCreate } from '../../src/domain/archive.js'
import { extractArchiveTo, main, pipelineRunCmd, transform } from '../../src/adapters/cli.js'

// extractArchiveTo exercises the CLI's actual filesystem-writing extract path —
// the real attack surface the zip-slip guard protects, as opposed to
// domain/archive.test.ts which only exercises the pure parse/decode step.

// Mirrors test/adapters/op-run.test.ts's buildMinimalPng — scrub (sanitizeImage)
// only accepts real JPEG/PNG magic bytes, so the `pipeline run` unzip->scrub
// test below needs an actual (if minimal) PNG, not arbitrary bytes.
function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, data.length)
  const typeBytes = new TextEncoder().encode(type)
  const crc = new Uint8Array(4)
  const out = new Uint8Array(4 + typeBytes.length + data.length + 4)
  out.set(len, 0); out.set(typeBytes, 4); out.set(data, 4 + typeBytes.length); out.set(crc, 4 + typeBytes.length + data.length)
  return out
}

function buildMinimalPng(): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', new Uint8Array(13)), chunk('IDAT', new Uint8Array([0])), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

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

  it('writes entries from a tar.gz archive', () => {
    const out = tmpDir()
    const packed = archiveCreate('tar.gz', [{ name: 'a.txt', data: new TextEncoder().encode('hello') }])
    const { written, skipped } = extractArchiveTo('tar.gz', packed, out)
    expect(written).toBe(1)
    expect(skipped).toEqual([])
    expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hello')
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

  it('rejects a non-numeric --mtime instead of silently packing NaN', async () => {
    const work = tmpDir()
    const inPath = join(work, 'in.txt')
    const outPath = join(work, 'out.zip')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(inPath, 'hello')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    await main(['node', 'suxlib-fileops', 'archive', 'create', '-o', outPath, '-m', 'not-a-number', inPath])
    expect(process.exitCode).toBe(1)
    expect(existsSync(outPath)).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/--mtime must be a numeric epoch-ms value/))
    process.exitCode = 0
    errSpy.mockRestore()
  })
})

describe('cli `pipeline run` (real CLI entry point)', () => {
  it('runs a single-leaf spec, resolving a $file input marker off disk and printing the dehydrated result', async () => {
    const work = tmpDir()
    const dataPath = join(work, 'data.json')
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dataPath, '{"a":1}')
    writeFileSync(
      specPath,
      JSON.stringify({
        spec: { tag: 'leaf', name: 'convert' },
        input: { handle: { $file: 'data.json', type: 'application/json' }, from: 'json', to: 'yaml' },
      }),
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath])
    expect(process.exitCode).toBeFalsy()
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as { base64: string }
    expect(Buffer.from(printed.base64, 'base64').toString('utf8')).toBe('a: 1')
    logSpy.mockRestore()
  })

  it('runs a pipe(unzip, map(scrub)) spec and writes dehydrated Handle results to --output instead of inlining base64', async () => {
    const work = tmpDir()
    const outDir = join(work, 'out')
    const zipPath = join(work, 'bundle.zip')
    const specPath = join(work, 'spec.json')
    const packed = archiveCreate('zip', [{ name: 'a.png', data: buildMinimalPng() }])
    const { writeFileSync } = await import('node:fs')
    writeFileSync(zipPath, packed)
    writeFileSync(
      specPath,
      JSON.stringify({
        spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'unzip' }, { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 }] },
        input: { $file: 'bundle.zip', type: 'application/zip' },
      }),
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath, '-o', outDir])
    expect(process.exitCode).toBeFalsy()
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as Array<{ kind: string; handle: { file: string; type: string; size: number } }>
    expect(printed).toHaveLength(1)
    expect(printed[0].kind).toBe('png')
    expect(existsSync(join(outDir, printed[0].handle.file))).toBe(true)
    expect(readFileSync(join(outDir, printed[0].handle.file)).length).toBeGreaterThan(0)
    logSpy.mockRestore()
  })

  it('preserves a "__proto__"-keyed result value under --output instead of silently dropping it', async () => {
    const work = tmpDir()
    const outDir = join(work, 'out')
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    // wrapHandle doesn't validate its input is a real Handle -- it just
    // echoes whatever it's given under a fixed "handle" key (src/op/reshape.ts)
    // -- so this spec's result is `{ handle: <input> }`, putting the
    // caller-supplied "__proto__" key two levels deep in the result value
    // extractHandleFiles walks. Written as raw JSON text, not a JS object
    // literal, so the "__proto__" key round-trips as a genuine own property
    // (JSON.parse doesn't apply the object-literal grammar's exotic
    // "__proto__: value" prototype-setter behavior).
    writeFileSync(specPath, `{"spec":{"tag":"leaf","name":"wrapHandle"},"input":{"a":1,"__proto__":{"pwned":true}}}`)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath, '-o', outDir])
    expect(process.exitCode).toBeFalsy()
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as { handle: Record<string, unknown> }
    expect(Object.prototype.hasOwnProperty.call(printed.handle, '__proto__')).toBe(true)
    expect(printed.handle.__proto__).toEqual({ pwned: true })
    expect(printed.handle.a).toBe(1)
    logSpy.mockRestore()
  })

  it('surfaces a missing `spec` field as a clean error instead of a crash', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ input: null }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath])
    expect(process.exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/must contain a `spec`/))
    process.exitCode = 0
    errSpy.mockRestore()
  })

  it('surfaces an unknown leaf name as a clean error instead of a crash', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'nope' }, input: null }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath])
    expect(process.exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown leaf "nope"/))
    process.exitCode = 0
    errSpy.mockRestore()
  })

  it('summarize throws with no opRunOpts.llm supplied to main()', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'summarize' }, input: { $file: 'in.txt' } }))
    writeFileSync(join(work, 'in.txt'), 'the full text')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath])
    expect(process.exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/llm capability is not available/))
    process.exitCode = 0
    errSpy.mockRestore()
  })

  it('a programmatic caller can supply main()\'s opRunOpts.llm to reach the summarize leaf', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'summarize' }, input: { $file: 'in.txt' } }))
    writeFileSync(join(work, 'in.txt'), 'the full text')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['node', 'suxlib-fileops', 'pipeline', 'run', specPath],
      { llm: { markdownFromPdf: async () => { throw new Error('unused') }, summarize: async (text) => `summary of ${text}` } },
    )
    expect(process.exitCode).toBeFalsy()
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as { abstract: string }
    expect(printed.abstract).toBe('summary of the full text')
    logSpy.mockRestore()
  })

  it('--config loads an OpRunOpts.llm from a module\'s default export, reaching the summarize leaf from the real bin entry point', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const configPath = join(work, 'op-run.config.mjs')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'summarize' }, input: { $file: 'in.txt' } }))
    writeFileSync(join(work, 'in.txt'), 'the full text')
    writeFileSync(
      configPath,
      'export default { llm: { markdownFromPdf: async () => { throw new Error("unused") }, summarize: async (text) => `config summary of ${text}` } }\n',
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath, '--config', configPath])
    expect(process.exitCode).toBeFalsy()
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as { abstract: string }
    expect(printed.abstract).toBe('config summary of the full text')
    logSpy.mockRestore()
  })

  it('a programmatic caller can supply main()\'s opRunOpts.leaves to reach a custom leaf', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 } }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['node', 'suxlib-fileops', 'pipeline', 'run', specPath],
      { leaves: { shout: async (input) => ({ shouted: input }) } },
    )
    expect(process.exitCode).toBeFalsy()
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string) as { shouted: { a: number } }
    expect(printed.shouted).toEqual({ a: 1 })
    logSpy.mockRestore()
  })

  it('main() refreshes `pipeline run`\'s description with opRunOpts.leaves-registered leaf names (#158)', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 } }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['node', 'suxlib-fileops', 'pipeline', 'run', specPath],
      { leaves: { shout: async (input) => input } },
    )
    logSpy.mockRestore()
    expect(pipelineRunCmd.description()).toContain('shout')
    expect(pipelineRunCmd.description()).toContain('convert')
  })

  it('--config surfaces a module with no default export as a clean error', async () => {
    const work = tmpDir()
    const specPath = join(work, 'spec.json')
    const configPath = join(work, 'op-run.config.mjs')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(specPath, JSON.stringify({ spec: { tag: 'leaf', name: 'summarize' }, input: { $file: 'in.txt' } }))
    writeFileSync(join(work, 'in.txt'), 'the full text')
    writeFileSync(configPath, 'export const notDefault = {}\n')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
    await main(['node', 'suxlib-fileops', 'pipeline', 'run', specPath, '--config', configPath])
    expect(process.exitCode).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/must have a default export/))
    process.exitCode = 0
    errSpy.mockRestore()
  })
})
