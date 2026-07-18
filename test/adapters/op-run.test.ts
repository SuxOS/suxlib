import { test, expect } from 'vitest'
import { zipSync } from 'fflate'
import { runOpSpec } from '../../src/adapters/op-run.js'
import { bytesToB64 } from '../../src/adapters/base64.js'
import type { OpSpec } from '../../src/op/spec.js'
import { createGovernor } from '../../src/control/governor.js'
import { MemoryStore, type Cache } from '../../src/effects/types.js'

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

test('runOpSpec: unzip -> map(scrub) hydrates a $handle input and dehydrates Handle results back to base64', async () => {
  const png = buildMinimalPng()
  const zip = zipSync({ 'a.png': png })
  const spec: OpSpec = {
    tag: 'pipe',
    steps: [
      { tag: 'leaf', name: 'unzip' },
      { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 },
    ],
  }
  const result = await runOpSpec({ spec, input: { $handle: true, base64: bytesToB64(zip), type: 'application/zip' } }) as Array<{ kind: string; handle: { base64: string; type: string; size: number } }>
  expect(result).toHaveLength(1)
  expect(result[0].kind).toBe('png')
  expect(result[0].handle.base64).toBeTypeOf('string')
  expect(result[0].handle.size).toBeGreaterThan(0)
})

test('runOpSpec: a single leaf spec round-trips through convert', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  const result = await runOpSpec({
    spec,
    input: { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' },
  }) as { base64: string }
  expect(Buffer.from(result.base64, 'base64').toString('utf8')).toBe('a: 1')
})

test('runOpSpec: rejects an unknown leaf name via buildOp', async () => {
  await expect(runOpSpec({ spec: { tag: 'leaf', name: 'nope' } as OpSpec, input: null })).rejects.toThrow(/unknown leaf "nope"/)
})

test('runOpSpec: a "__proto__"-keyed input cannot inject an inherited `to` into the leaf input', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  // `to` is only reachable through the poisoned prototype -- never as an own
  // property of the parsed input. If hydrate() copied properties onto a plain
  // {} accumulator, assigning the "__proto__" key would hit the inherited
  // Annex-B setter and reassign the accumulator's own prototype instead of
  // storing an ordinary "__proto__"-named property, and `to` would then
  // resolve as an *inherited* property straight through to the convert leaf.
  const maliciousInput = JSON.parse(
    `{"handle":{"$handle":true,"base64":"${bytesToB64(new TextEncoder().encode('{"a":1}'))}","type":"application/json"},"from":"json","__proto__":{"to":"yaml"}}`,
  )
  await expect(runOpSpec({ spec, input: maliciousInput })).rejects.toThrow(/Unsupported target format/)
})

test('runOpSpec: opts.cache is a long-lived instance a host reuses across calls, so a memo leaf runs only once for repeated input', async () => {
  let gets = 0
  let puts = 0
  const backing = new Map<string, unknown>()
  const cache: Cache = {
    async get(key) { gets++; return backing.get(key) },
    async put(key, value) { puts++; backing.set(key, value) },
  }
  // A memoized leaf's cached result is Handle-shaped, and a Handle only
  // resolves against the Store instance that produced it -- opts.store must
  // be shared across both calls too (see OpRunOpts's doc), or the second
  // call's cache hit would fail to dehydrate against its own fresh Store.
  const store = new MemoryStore()
  const spec: OpSpec = { tag: 'leaf', name: 'convert', opts: { memo: true } }
  const input = { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' }

  const first = await runOpSpec({ spec, input }, { cache, store }) as { base64: string }
  const second = await runOpSpec({ spec, input }, { cache, store }) as { base64: string }

  expect(Buffer.from(first.base64, 'base64').toString('utf8')).toBe('a: 1')
  expect(second).toEqual(first)
  expect(gets).toBe(2)
  expect(puts).toBe(1)
})

test('runOpSpec: hydrate() bails on the aggregate byte guard across multiple $handle refs instead of decoding every one first', async () => {
  const { MAX_HYDRATE_BYTES } = await import('../../src/adapters/op-run.js')
  const big = bytesToB64(new TextEncoder().encode('x'.repeat(Math.ceil(MAX_HYDRATE_BYTES / 2) + 1)))
  const spec: OpSpec = { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 2 }
  const input = [{ $handle: true, base64: big }, { $handle: true, base64: big }]
  await expect(runOpSpec({ spec, input })).rejects.toThrow(/bomb guard/)
})

test('runOpSpec: opts.governors persist breaker state across separate calls, not just within one', async () => {
  const governors = { convert: createGovernor('convert', { circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, halfOpenSuccesses: 1 } }) }
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  const failingInput = { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('not json')), type: 'application/json' }, from: 'json', to: 'yaml' }
  await expect(runOpSpec({ spec, input: failingInput }, { governors })).rejects.toThrow()

  const validInput = { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' }
  await expect(runOpSpec({ spec, input: validInput }, { governors })).rejects.toThrow(/circuit open/)
})
