import { test, expect } from 'vitest'
import { zipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { buildOp, validateOpSpec, MAX_LEAF_RETRIES, type OpSpec } from '../../src/op/spec.js'
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

test('buildOp rejects an out-of-range sink `opts.retries` (#247)', () => {
  expect(() => buildOp({ tag: 'sink', targets: ['out'], opts: { retries: -1 } })).toThrow(/opts\.retries/)
  expect(() => buildOp({ tag: 'sink', targets: ['out'], opts: { retries: MAX_LEAF_RETRIES + 1 } })).toThrow(/opts\.retries/)
})

test('buildOp threads a sink spec\'s opts.retries into a retried write via caps.governors["sink:<name>"] (#247)', async () => {
  let calls = 0
  const spec: OpSpec = { tag: 'sink', targets: ['out'], opts: { retries: 2 } }
  const tree = buildOp(spec)
  const result = await runInline(tree, 'value', {
    store: caps().store, llm: {} as any, clock: { now: () => 0 },
    sinks: { out: { name: 'out', write: async (v: any) => { calls++; if (calls < 2) throw new Error('flaky'); return v } } },
  }, { sleep: async () => {}, rand: () => 0 })
  expect(result).toBe('value')
  expect(calls).toBe(2)
})

test('buildOp rejects a sink spec with an invalid per-target `opts.retries` (#251)', () => {
  expect(() => buildOp({ tag: 'sink', targets: [{ name: 'out', opts: { retries: -1 } }] })).toThrow(/targets/)
  expect(() => buildOp({ tag: 'sink', targets: [{ name: '' }] })).toThrow(/targets/)
})

test('buildOp threads a per-target sink opts.retries, overriding the fanout-level default (#251)', async () => {
  let logCalls = 0; let vaultCalls = 0
  const spec: OpSpec = { tag: 'sink', targets: ['log', { name: 'vault', opts: { retries: 0 } }], opts: { retries: 3 } }
  const tree = buildOp(spec)
  await expect(runInline(tree, 'value', {
    store: caps().store, llm: {} as any, clock: { now: () => 0 },
    sinks: {
      log: { name: 'log', write: async (v: any) => { logCalls++; if (logCalls < 3) throw new Error('flaky'); return v } },
      vault: { name: 'vault', write: async () => { vaultCalls++; throw new Error('flaky') } },
    },
  }, { sleep: async () => {}, rand: () => 0 })).rejects.toThrow('flaky')
  expect(logCalls).toBe(3)
  expect(vaultCalls).toBe(1)
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

test('buildOp rejects a non-boolean leaf `opts.heavy`/`opts.memo` instead of silently misrouting it (#318)', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'scrub', opts: { heavy: 'false' as any } })).toThrow(/opts\.heavy/)
  expect(() => buildOp({ tag: 'leaf', name: 'scrub', opts: { memo: '0' as any } })).toThrow(/opts\.memo/)
})

test('buildOp rejects a non-boolean sink `opts.heavy`/`opts.memo`, including on a per-target opts (#318)', () => {
  expect(() => buildOp({ tag: 'sink', targets: ['out'], opts: { heavy: 'false' as any } })).toThrow(/opts\.heavy/)
  expect(() => buildOp({ tag: 'sink', targets: ['out'], opts: { memo: '0' as any } })).toThrow(/opts\.memo/)
  expect(() => buildOp({ tag: 'sink', targets: [{ name: 'out', opts: { heavy: 'false' as any } }] })).toThrow(/targets/)
})

test('buildOp rejects an invalid leaf `opts.kind` instead of silently bypassing reliability gating (#262)', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'scrub', opts: { kind: 'nope' as any } })).toThrow(/opts\.kind/)
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

test('buildOp builds a catch node that falls back to a secondary sink when the primary sink fails (#183)', async () => {
  const { store } = caps()
  const written: string[] = []
  const spec: OpSpec = {
    tag: 'catch',
    try: { tag: 'sink', targets: ['primary'] },
    catch: { tag: 'sink', targets: ['secondary'] },
  }
  const tree = buildOp(spec)
  const sinks = {
    primary: { name: 'primary', write: async () => { throw new Error('primary is down') } },
    secondary: { name: 'secondary', write: async (v: any) => { written.push(v); return v } },
  }
  const result = await runInline(tree, 'payload', { store, llm: {} as any, clock: { now: () => 0 }, sinks })
  expect(written).toEqual(['payload'])
  expect(result).toBe('payload')
})

test('buildOp\'s catch node lets a successful try branch skip the catch branch entirely', async () => {
  const { store } = caps()
  const written: string[] = []
  const spec: OpSpec = {
    tag: 'catch',
    try: { tag: 'sink', targets: ['primary'] },
    catch: { tag: 'sink', targets: ['secondary'] },
  }
  const tree = buildOp(spec)
  const sinks = {
    primary: { name: 'primary', write: async (v: any) => { written.push(`primary:${v}`); return v } },
    secondary: { name: 'secondary', write: async (v: any) => { written.push(`secondary:${v}`); return v } },
  }
  await runInline(tree, 'payload', { store, llm: {} as any, clock: { now: () => 0 }, sinks })
  expect(written).toEqual(['primary:payload'])
})

test('buildOp rejects a catch spec missing `try`/`catch`', () => {
  expect(() => buildOp({ tag: 'catch', catch: { tag: 'leaf', name: 'scrub' } } as unknown as OpSpec)).toThrow(/requires a `try`/)
  expect(() => buildOp({ tag: 'catch', try: { tag: 'leaf', name: 'scrub' } } as unknown as OpSpec)).toThrow(/requires a `catch`/)
})

test('buildOp\'s shape check treats a catch node\'s boundary as \'unknown\' when its try/catch branches disagree, so it never blocks a downstream pipe step', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'catch', try: { tag: 'leaf', name: 'unzip' }, catch: { tag: 'leaf', name: 'scrub' } },
      { tag: 'leaf', name: 'unwrapHandle' },
    ],
  }
  expect(() => buildOp(spec)).not.toThrow()
})

test('buildOp\'s shape check catches a downstream mismatch when a catch node\'s try/catch branches agree on a bare-`handle` output', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'catch', try: { tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } }, catch: { tag: 'leaf', name: 'extract' } },
      { tag: 'leaf', name: 'unwrapHandle' },
    ],
  }
  expect(() => buildOp(spec)).toThrow(/pipe step 1 \("unwrapHandle"\) expects \{handle\} input, but step 0 \("catch"\) produces handle/)
})

test('mapField rejects `__proto__` as `arrayField`/`elementField`/`renameTo`', () => {
  expect(() => buildOp({ tag: 'mapField', arrayField: '__proto__', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 })).toThrow(/arrayField/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', elementField: '__proto__', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2 })).toThrow(/elementField/)
  expect(() => buildOp({ tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2, renameTo: '__proto__' })).toThrow(/renameTo/)
})

test('buildOp builds an ask node that degrades gracefully with no Ask capability (#181)', async () => {
  const store = new MemoryStore()
  const askOp: OpSpec = { tag: 'ask', prompt: 'proceed?', timeout: '5m', onTimeout: 'proceed' }
  expect(await runInline(buildOp(askOp), 'piped-through', { store, llm: undefined as any, clock: { now: () => 0 }, sinks: {} })).toBe('piped-through')

  const failOp: OpSpec = { tag: 'ask', prompt: 'proceed?', timeout: '5m', onTimeout: 'fail' }
  await expect(runInline(buildOp(failOp), 'x', { store, llm: undefined as any, clock: { now: () => 0 }, sinks: {} })).rejects.toThrow(/ask timed out/)
})

test('buildOp rejects an ask spec missing `prompt`/`timeout` or with a bad `onTimeout`', () => {
  expect(() => buildOp({ tag: 'ask', timeout: '5m', onTimeout: 'proceed' } as unknown as OpSpec)).toThrow(/prompt/)
  expect(() => buildOp({ tag: 'ask', prompt: 'x', onTimeout: 'proceed' } as unknown as OpSpec)).toThrow(/timeout/)
  expect(() => buildOp({ tag: 'ask', prompt: 'x', timeout: '5m', onTimeout: 'nope' } as unknown as OpSpec)).toThrow(/onTimeout/)
})

test('buildOp builds a saga node that compensates an already-succeeded step\'s own sink write when a later step fails (#354)', async () => {
  const { store } = caps()
  const written: string[] = []
  const spec: OpSpec = {
    tag: 'saga',
    steps: [
      { op: { tag: 'sink', targets: ['primary'] }, compensate: { tag: 'sink', targets: ['undo'] } },
      { op: { tag: 'leaf', name: 'nope-always-fails' } },
    ],
  }
  const tree = buildOp(spec, { 'nope-always-fails': async () => { throw new Error('step 2 failed') } })
  const sinks = {
    primary: { name: 'primary', write: async (v: any) => { written.push(`primary:${v}`); return v } },
    undo: { name: 'undo', write: async (v: any) => { written.push(`undo:${v}`); return v } },
  }
  await expect(runInline(tree, 'payload', { store, llm: {} as any, clock: { now: () => 0 }, sinks })).rejects.toThrow('step 2 failed')
  expect(written).toEqual(['primary:payload', 'undo:payload'])
})

test('buildOp\'s saga node runs no compensation when every step succeeds', async () => {
  const { store } = caps()
  let compensated = false
  const spec: OpSpec = {
    tag: 'saga',
    steps: [
      { op: { tag: 'leaf', name: 'id' }, compensate: { tag: 'leaf', name: 'undo' } },
    ],
  }
  const tree = buildOp(spec, { id: async (v: any) => v, undo: async (v: any) => { compensated = true; return v } })
  const result = await runInline(tree, 'payload', { store, llm: {} as any, clock: { now: () => 0 }, sinks: {} })
  expect(result).toBe('payload')
  expect(compensated).toBe(false)
})

test('buildOp rejects a saga spec with an empty `steps` array, or a step missing `op`', () => {
  expect(() => buildOp({ tag: 'saga', steps: [] } as unknown as OpSpec)).toThrow(/non-empty `steps`/)
  expect(() => buildOp({ tag: 'saga', steps: [{}] } as unknown as OpSpec)).toThrow(/requires an `op`/)
})

test('validateOpSpec collects saga step errors, including inside a step\'s `op`/`compensate`, without stopping at the first', () => {
  const spec = {
    tag: 'saga',
    steps: [
      { op: { tag: 'leaf', name: 'nope' }, compensate: { tag: 'leaf', name: 'also-nope' } },
      {},
    ],
  } as unknown as OpSpec
  const errors = validateOpSpec(spec)
  expect(errors.some((e) => /unknown leaf "nope"/.test(e.message))).toBe(true)
  expect(errors.some((e) => /unknown leaf "also-nope"/.test(e.message))).toBe(true)
  expect(errors.some((e) => /requires an `op`/.test(e.message))).toBe(true)
})

test('validateOpSpec returns an empty array for a well-formed spec, mirroring buildOp not throwing (#208)', () => {
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'unzip' }, { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 }] }
  expect(validateOpSpec(spec)).toEqual([])
  expect(() => buildOp(spec)).not.toThrow()
})

test('validateOpSpec collects every structural error in one pass instead of stopping at the first, unlike buildOp', () => {
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'nope', opts: { retries: 99 } },
      { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 0 },
      { tag: 'sink', targets: [] },
    ],
  }
  const errors = validateOpSpec(spec)
  expect(errors.length).toBeGreaterThanOrEqual(3)
  expect(errors.some((e) => /unknown leaf "nope"/.test(e.message))).toBe(true)
  expect(errors.some((e) => /retries/.test(e.message))).toBe(true)
  expect(errors.some((e) => /concurrency/.test(e.message))).toBe(true)
  expect(errors.some((e) => /targets/.test(e.message))).toBe(true)
  // buildOp, by contrast, throws on just the first problem it hits.
  expect(() => buildOp(spec)).toThrow(/unknown leaf "nope"/)
})

test('validateOpSpec descends into nested branches (pipe steps, map/mapField op, catch try/catch) even when a sibling node also errors', () => {
  const spec: OpSpec = {
    tag: 'catch',
    try: { tag: 'leaf', name: 'nope-try' },
    catch: { tag: 'leaf', name: 'nope-catch' },
  }
  const errors = validateOpSpec(spec)
  expect(errors.some((e) => e.path === '$.try' && /unknown leaf "nope-try"/.test(e.message))).toBe(true)
  expect(errors.some((e) => e.path === '$.catch' && /unknown leaf "nope-catch"/.test(e.message))).toBe(true)
})

test('validateOpSpec reports a pipe-adjacency shape mismatch the same way buildOp\'s throw does', () => {
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } }, { tag: 'leaf', name: 'unwrapHandle' }] }
  const errors = validateOpSpec(spec)
  expect(errors).toHaveLength(1)
  expect(errors[0].message).toMatch(/pipe step 1 \("unwrapHandle"\) expects \{handle\} input, but step 0 \("convert"\) produces handle/)
})

test('validateOpSpec resolves extraLeaves the same way buildOp does', () => {
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  expect(validateOpSpec(spec)).not.toEqual([])
  expect(validateOpSpec(spec, { shout: async (i) => i })).toEqual([])
})

test('validateOpSpec reports an invalid leaf `opts.kind` the same way buildOp\'s throw does (#262)', () => {
  const spec: OpSpec = { tag: 'leaf', name: 'scrub', opts: { kind: 'nope' as any } }
  const errors = validateOpSpec(spec)
  expect(errors.some((e) => /opts\.kind/.test(e.message))).toBe(true)
})

test('validateOpSpec reports a non-boolean leaf `opts.heavy`/`opts.memo` the same way buildOp\'s throw does (#318)', () => {
  const spec: OpSpec = { tag: 'leaf', name: 'scrub', opts: { heavy: 'false' as any, memo: '0' as any } }
  const errors = validateOpSpec(spec)
  expect(errors.some((e) => /opts\.heavy/.test(e.message))).toBe(true)
  expect(errors.some((e) => /opts\.memo/.test(e.message))).toBe(true)
})

test('validateOpSpec reports an out-of-range sink `opts.retries` the same way buildOp\'s throw does (#247)', () => {
  const spec: OpSpec = { tag: 'sink', targets: ['out'], opts: { retries: MAX_LEAF_RETRIES + 1 } }
  const errors = validateOpSpec(spec)
  expect(errors).toHaveLength(1)
  expect(errors[0].message).toMatch(/opts\.retries/)
  expect(() => buildOp(spec)).toThrow(/opts\.retries/)
})
