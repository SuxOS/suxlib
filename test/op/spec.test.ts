import { test, expect } from 'vitest'
import { zipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { buildOp, type OpSpec } from '../../src/op/spec.js'
import { runInline } from '../../src/runtime/inline.js'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, putText, resolveText } from '../../src/handles/handle.js'

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

test('buildOp rejects a non-object `params`', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'convert', params: [] as unknown as Record<string, unknown> })).toThrow(/params/)
})

test('buildOp rejects an unknown leaf name', () => {
  expect(() => buildOp({ tag: 'leaf', name: 'nope' })).toThrow(/unknown leaf "nope"/)
})

test('buildOp rejects an unsupported tag (e.g. sink/ask, which need host capabilities)', () => {
  expect(() => buildOp({ tag: 'sink' } as unknown as OpSpec)).toThrow(/unsupported op spec tag "sink"/)
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

test('buildOp builds a working reconcile node, needing only caps.store like every leaf', async () => {
  const { store, ...rest } = caps()
  const a = await putText(store, JSON.stringify({ x: 1 }), 'application/json')
  const b = await putText(store, JSON.stringify({ y: 2 }), 'application/json')

  const spec: OpSpec = { tag: 'reconcile', opts: { mode: 'field-merge' } }
  const tree = buildOp(spec)
  const result = await runInline(tree, [a, b], { store, ...rest })
  expect(JSON.parse(await resolveText(store, result))).toEqual({ x: 1, y: 2 })
})

test('a pipe can end in reconcile, merging a map\'s fanned-out output back into one handle', async () => {
  const { store, ...rest } = caps()
  const zip = zipSync({ 'a.json': new TextEncoder().encode('{"a":1}'), 'b.json': new TextEncoder().encode('{"b":2}') })
  const zipHandle = await putBytes(store, zip, 'application/zip')

  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      { tag: 'reconcile', opts: { mode: 'field-merge' } },
    ],
  }
  const tree = buildOp(spec)
  const result = await runInline(tree, zipHandle, { store, ...rest })
  expect(JSON.parse(await resolveText(store, result))).toEqual({ a: 1, b: 2 })
})

test('buildOp rejects a reconcile spec with an invalid mode', () => {
  expect(() => buildOp({ tag: 'reconcile', opts: { mode: 'nope' } } as unknown as OpSpec)).toThrow(/opts\.mode/)
})
