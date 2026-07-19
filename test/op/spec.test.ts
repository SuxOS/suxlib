import { test, expect } from 'vitest'
import { zipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { buildOp, type OpSpec } from '../../src/op/spec.js'
import { runInline } from '../../src/runtime/inline.js'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolve, resolveText } from '../../src/handles/handle.js'
import { archiveExtract } from '../../src/domain/archive.js'

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, data.length)
  const typeBytes = new TextEncoder().encode(type)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes); crcInput.set(data, typeBytes.length)
  const crc = new Uint8Array(4) // zeroed CRC is fine — sanitizeImage doesn't validate it
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

const caps = () => {
  const store = new MemoryStore()
  return { store, llm: {} as any, clock: { now: () => 0 }, sinks: {} }
}

test('buildOp builds a working leaf/pipe/map tree that resolves names against the registry', async () => {
  const { store, ...rest } = caps()
  const png = buildMinimalPng()
  const zip = zipSync({ 'a.png': png, 'b.png': png })
  const zipHandle = await putBytes(store, zip, 'application/zip')

  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 },
    ],
  }
  const tree = buildOp(spec)
  const result = await runInline(tree, zipHandle, { store, ...rest })
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ kind: 'png' })
  expect(result[1]).toMatchObject({ kind: 'png' })
})

test('leaf spec `params` merges convert\'s required `to`/`from` onto wrapHandle\'s output, so unzip -> map(convert) is expressible via a JSON op spec', async () => {
  const { store, ...rest } = caps()
  const zip = zipSync({ 'a.json': new TextEncoder().encode('{"a":1}') })
  const zipHandle = await putBytes(store, zip, 'application/zip')

  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      {
        tag: 'map',
        op: {
          tag: 'pipe',
          steps: [
            { tag: 'leaf', name: 'wrapHandle' },
            { tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } },
          ],
        },
        concurrency: 2,
      },
    ],
  }
  const tree = buildOp(spec)
  const result = await runInline(tree, zipHandle, { store, ...rest })
  expect(result).toHaveLength(1)
  expect(await resolveText(store, result[0])).toBe('a: 1')
})

test('leaf spec `params` cannot inject `to` via a "__proto__" key', async () => {
  const { store, ...rest } = caps()
  const handle = await putBytes(store, new TextEncoder().encode('{"a":1}'), 'application/json')
  // `to` is only reachable through the poisoned prototype -- never as an own
  // property of `params`. If mergeParams assigned it onto a plain {} via
  // bracket notation, it would hit the inherited Annex-B setter and reassign
  // the merged object's own prototype instead of storing an ordinary
  // "__proto__"-named property, and `to` would then resolve as an
  // *inherited* property straight through to the convert leaf.
  const params = JSON.parse('{"from":"json","__proto__":{"to":"yaml"}}')
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'wrapHandle' }, { tag: 'leaf', name: 'convert', params }] }
  const tree = buildOp(spec)
  await expect(runInline(tree, handle, { store, ...rest })).rejects.toThrow(/Unsupported target format/)
})

test('leaf spec `params` is folded into the memo cache key, so two differently-parameterized calls with the same piped input don\'t collide (#131)', async () => {
  const { store, ...rest } = caps()
  const backing = new Map<string, unknown>()
  const cache = { async get(key: string) { return backing.get(key) }, async put(key: string, value: unknown) { backing.set(key, value) } }
  const handle = await putBytes(store, new TextEncoder().encode('{"a":1}'), 'application/json')

  const specYaml: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'wrapHandle' }, { tag: 'leaf', name: 'convert', opts: { memo: true }, params: { from: 'json', to: 'yaml' } }] }
  const specJson: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'wrapHandle' }, { tag: 'leaf', name: 'convert', opts: { memo: true }, params: { from: 'json', to: 'json' } }] }

  const yamlResult = await runInline(buildOp(specYaml), handle, { store, ...rest, cache }) as import('../../src/effects/types.js').Handle
  const jsonResult = await runInline(buildOp(specJson), handle, { store, ...rest, cache }) as import('../../src/effects/types.js').Handle

  expect(await resolveText(store, yamlResult)).toBe('a: 1')
  expect(JSON.parse(await resolveText(store, jsonResult))).toEqual({ a: 1 })
})

test('buildOp rejects a non-object `params`', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'convert', params: [] as unknown as Record<string, unknown> })).toThrow(/params/)
})

test('buildOp rejects an unknown leaf name', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'nope' })).toThrow(/unknown leaf "nope"/)
})

test('buildOp rejects an unsupported tag', () => {
  expect(() => buildOp({ tag: 'nope' } as unknown as OpSpec)).toThrow(/unsupported op spec tag "nope"/)
})

test('buildOp builds an ask node that degrades gracefully with no Ask capability, honoring onTimeout: proceed', async () => {
  const { store, ...rest } = caps()
  const spec: OpSpec = { tag: 'ask', prompt: 'ok?', timeout: '5m', onTimeout: 'proceed' }
  const tree = buildOp(spec)
  const result = await runInline(tree, 'piped-value', { store, ...rest })
  expect(result).toBe('piped-value')
})

test('buildOp builds an ask node whose onTimeout: fail throws with no Ask capability supplied', async () => {
  const { store, ...rest } = caps()
  const spec: OpSpec = { tag: 'ask', prompt: 'ok?', timeout: '5m', onTimeout: 'fail' }
  const tree = buildOp(spec)
  await expect(runInline(tree, 'piped-value', { store, ...rest })).rejects.toThrow(/ok\?/)
})

test('buildOp rejects an ask spec missing prompt/timeout, or with a bad onTimeout', () => {
  expect(() => buildOp({ tag: 'ask', prompt: '', timeout: '5m', onTimeout: 'proceed' } as OpSpec)).toThrow(/prompt/)
  expect(() => buildOp({ tag: 'ask', prompt: 'ok?', timeout: '', onTimeout: 'proceed' } as OpSpec)).toThrow(/timeout/)
  expect(() => buildOp({ tag: 'ask', prompt: 'ok?', timeout: '5m', onTimeout: 'nope' as any })).toThrow(/onTimeout/)
})

test('buildOp builds a reconcile node that merges Handles via caps.store, no extra host capability needed', async () => {
  const { store, ...rest } = caps()
  const a = await putBytes(store, new TextEncoder().encode('{"x":1}'), 'application/json')
  const b = await putBytes(store, new TextEncoder().encode('{"x":2,"y":3}'), 'application/json')
  const spec: OpSpec = { tag: 'reconcile', opts: { mode: 'field-merge', defaultPolicy: 'last-write-wins' } }
  const tree = buildOp(spec)
  const result = await runInline(tree, [a, b], { store, ...rest })
  expect(JSON.parse(await resolveText(store, result))).toEqual({ x: 2, y: 3 })
})

test('buildOp rejects a reconcile spec with an unknown mode', () => {
  expect(() => buildOp({ tag: 'reconcile', opts: { mode: 'nope' } } as unknown as OpSpec)).toThrow(/opts\.mode/)
})

test('buildOp rejects a reconcile field-merge spec with an unknown defaultPolicy', () => {
  expect(() => buildOp({ tag: 'reconcile', opts: { mode: 'field-merge', defaultPolicy: 'nope' as any } })).toThrow(/opts\.defaultPolicy/)
})

test('buildOp rejects a reconcile field-merge spec with an unknown per-field policy', () => {
  expect(() => buildOp({ tag: 'reconcile', opts: { mode: 'field-merge', policy: { x: 'nope' as any } } })).toThrow(/opts\.policy\["x"\]/)
})

test('buildOp builds a sink/fanout node whose targets resolve against caps.sinks at run time', async () => {
  const { store } = caps()
  const written: any[] = []
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'wrapHandle' }, { tag: 'sink', targets: ['out'] }] }
  const tree = buildOp(spec)
  const handle = await putBytes(store, new TextEncoder().encode('hi'), 'text/plain')
  const result = await runInline(tree, handle, { store, llm: {} as any, clock: { now: () => 0 }, sinks: { out: { name: 'out', write: async (v: any) => { written.push(v); return v } } } })
  expect(written).toEqual([{ handle }])
  expect(result).toEqual({ handle })
})

test('buildOp rejects a sink spec with an empty `targets` array', () => {
  expect(() => buildOp({ tag: 'sink', targets: [] })).toThrow(/targets/)
})

test('buildOp rejects a sink spec with a non-string target', () => {
  expect(() => buildOp({ tag: 'sink', targets: [1 as unknown as string] })).toThrow(/targets/)
})

test('buildOp rejects an empty pipe', () => {
  expect(() => buildOp({ tag: 'pipe', steps: [] })).toThrow(/non-empty `steps`/)
})

test('buildOp rejects an out-of-range map concurrency', () => {
  expect(() => buildOp({ tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 0 })).toThrow(/concurrency/)
  expect(() => buildOp({ tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 33 })).toThrow(/concurrency/)
})

test('buildOp rejects an out-of-range leaf retries', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'scrub', opts: { retries: 6 } })).toThrow(/retries/)
})

test('buildOp resolves a host-registered leaf via its `extraLeaves` param', async () => {
  const { store, ...rest } = caps()
  const handle = await putBytes(store, new TextEncoder().encode('hi'), 'text/plain')
  const shout: (input: unknown) => Promise<unknown> = async (input) => ({ shouted: input })
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const tree = buildOp(spec, { shout })
  const result = await runInline(tree, handle, { store, ...rest }) as { shouted: unknown }
  expect(result.shouted).toEqual(handle)
})

test('buildOp resolves an `extraLeaves` leaf nested inside pipe/map, not just a top-level leaf node', async () => {
  const { store, ...rest } = caps()
  const png = buildMinimalPng()
  const zip = zipSync({ 'a.png': png })
  const zipHandle = await putBytes(store, zip, 'application/zip')
  const tag: (input: unknown) => Promise<unknown> = async (input) => ({ tagged: true, input })
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      { tag: 'map', op: { tag: 'leaf', name: 'tag' }, concurrency: 2 },
    ],
  }
  const tree = buildOp(spec, { tag })
  const result = await runInline(tree, zipHandle, { store, ...rest }) as Array<{ tagged: boolean }>
  expect(result).toHaveLength(1)
  expect(result[0].tagged).toBe(true)
})

test('buildOp still rejects an unknown leaf name when `extraLeaves` is supplied but doesn\'t cover it', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'nope' }, { shout: async (i) => i })).toThrow(/unknown leaf "nope"/)
})

test('buildOp\'s `extraLeaves` lets a host-registered leaf shadow a built-in name', async () => {
  const { store, ...rest } = caps()
  const handle = await putBytes(store, new TextEncoder().encode('hi'), 'text/plain')
  const overriddenScrub: (input: unknown) => Promise<unknown> = async () => ({ overridden: true })
  const tree = buildOp({ tag: 'leaf', name: 'scrub' }, { scrub: overriddenScrub })
  const result = await runInline(tree, handle, { store, ...rest })
  expect(result).toEqual({ overridden: true })
})

test('buildOp rejects a pipe step whose declared shape mismatches the previous step\'s output (unwrapHandle straight after convert, #132)', () => {
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } }, { tag: 'leaf', name: 'unwrapHandle' }] }
  expect(() => buildOp(spec)).toThrow(/pipe step 1 \("unwrapHandle"\) expects \{handle\} input, but step 0 \("convert"\) produces handle/)
})

test('buildOp rejects a pipe step whose declared shape mismatches deep inside a nested pipe (e.g. inside a map\'s inner op)', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      {
        tag: 'map',
        op: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } }, { tag: 'leaf', name: 'unwrapHandle' }] },
        concurrency: 2,
      },
    ],
  }
  expect(() => buildOp(spec)).toThrow(/pipe step 1 \("unwrapHandle"\) expects \{handle\} input, but step 0 \("convert"\) produces handle/)
})

test('buildOp catches a shape mismatch at a map step\'s own boundary (#145): a bare-`handle`-producing step feeding a map whose inner leaf wants `handle[]`', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } },
      { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 },
    ],
  }
  expect(() => buildOp(spec)).toThrow(/pipe step 1 \("map"\) expects handle\[\] input, but step 0 \("convert"\) produces handle/)
})

test('buildOp rejects unpack feeding straight into pack (#161): unpack\'s `entries` field doesn\'t satisfy pack\'s `files` field now that both are declared as array-of-Handle-object shapes instead of \'unknown\'', () => {
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'unpack', params: { format: 'zip' } }, { tag: 'leaf', name: 'pack', params: { format: 'zip' } }] }
  expect(() => buildOp(spec)).toThrow(/pipe step 1 \("pack"\) expects \{format, files\} input, but step 0 \("unpack"\) produces \{entries, skipped\}/)
})

test('buildOp\'s map-boundary shape check allows unzip\'s `handle[]` feeding map(scrub), whose inner leaf wants a bare `handle`', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 },
    ],
  }
  expect(() => buildOp(spec)).not.toThrow()
})

test('buildOp allows a pipe step next to a host-registered extraLeaves leaf, treating its undeclared shape as compatible with anything', async () => {
  // `shout` has no LEAF_SHAPES entry (only built-in registry leaves do), so
  // its output reads as 'unknown' and is permissively compatible with
  // unwrapHandle's {handle} input -- buildOp doesn't throw. The mismatch
  // (shout's output has no `handle` field) only surfaces at run time -- as a
  // real error, not silently, since unwrapHandle itself throws on a missing
  // `handle` field (#159) -- same as any leaf pairing this shape scheme can't
  // represent at build time.
  const { store, ...rest } = caps()
  const handle = await putBytes(store, new TextEncoder().encode('hi'), 'text/plain')
  const shout: (input: unknown) => Promise<unknown> = async (input) => ({ shouted: input })
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'shout' }, { tag: 'leaf', name: 'unwrapHandle' }] }
  const tree = buildOp(spec, { shout })
  await expect(runInline(tree, handle, { store, ...rest })).rejects.toThrow(/unwrapHandle: input has no `handle` field/)
})

test('wrapHandle/unwrapHandle bridge unzip\'s bare-Handle output into shrink\'s {handle, ...opts} shape and back', async () => {
  const { store, ...rest } = caps()
  const pdfBytes = await (await PDFDocument.create()).save()
  const zip = zipSync({ 'a.pdf': pdfBytes })
  const zipHandle = await putBytes(store, zip, 'application/zip')

  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      {
        tag: 'map',
        op: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'wrapHandle' }, { tag: 'leaf', name: 'shrink' }, { tag: 'leaf', name: 'unwrapHandle' }] },
        concurrency: 2,
      },
    ],
  }
  const tree = buildOp(spec)
  const result = await runInline(tree, zipHandle, { store, ...rest })
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ type: 'application/pdf' })
})

test('mapField op spec makes unpack -> transform each entry -> pack expressible as a single pipeline (#168): entries -> files, each handle stamped in between', async () => {
  const { store, ...rest } = caps()
  const zip = zipSync({ 'a.txt': new TextEncoder().encode('hello'), 'b.txt': new TextEncoder().encode('world') })
  const zipHandle = await putBytes(store, zip, 'application/zip')

  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'wrapHandle' },
      { tag: 'leaf', name: 'unpack', params: { format: 'zip' } },
      { tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2, renameTo: 'files' },
      { tag: 'leaf', name: 'pack', params: { format: 'zip' } },
    ],
  }
  const tree = buildOp(spec)
  const packedHandle = await runInline(tree, zipHandle, { store, ...rest })
  const packedBytes = await resolve(store, packedHandle)
  const { entries } = archiveExtract('zip', packedBytes)
  expect(entries.map((e) => ({ name: e.name, text: e.text }))).toEqual(
    expect.arrayContaining([{ name: 'a.txt', text: 'hello' }, { name: 'b.txt', text: 'world' }]),
  )
})

test('mapField rejects a spec missing `arrayField`/`elementField`/`op`, and an out-of-range concurrency', () => {
  expect(() => buildOp({ tag: 'mapField', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 } as unknown as OpSpec)).toThrow(/arrayField/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 } as unknown as OpSpec)).toThrow(/elementField/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', elementField: 'handle', concurrency: 2 } as unknown as OpSpec)).toThrow(/requires an `op`/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 0 })).toThrow(/concurrency/)
})

test('buildOp\'s shape check passes unpack -> mapField(renameTo: \'files\') -> pack, unlike unpack -> pack directly (#161)', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unpack', params: { format: 'zip' } },
      { tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2, renameTo: 'files' },
      { tag: 'leaf', name: 'pack', params: { format: 'zip' } },
    ],
  }
  expect(() => buildOp(spec)).not.toThrow()
})

test('buildOp\'s shape check still rejects mapField feeding pack when the array field isn\'t renamed to `files`', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unpack', params: { format: 'zip' } },
      { tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 },
      { tag: 'leaf', name: 'pack', params: { format: 'zip' } },
    ],
  }
  expect(() => buildOp(spec)).toThrow(/pipe step 2 \("pack"\) expects \{format, files\} input, but step 1 \("mapField"\) produces \{entries\}/)
})

test('mapField rejects `__proto__` as `arrayField`/`elementField`/`renameTo`', () => {
  expect(() => buildOp({ tag: 'mapField', arrayField: '__proto__', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 })).toThrow(/arrayField/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', elementField: '__proto__', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 })).toThrow(/elementField/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2, renameTo: '__proto__' })).toThrow(/renameTo/)
})
