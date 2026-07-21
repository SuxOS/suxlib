import { test, expect } from 'vitest'
import { zipSync } from 'fflate'
import { runOpSpec, runOpSpecStatus } from '../../src/adapters/op-run.js'
import { bytesToB64 } from '../../src/adapters/base64.js'
import type { OpSpec } from '../../src/op/spec.js'
import { createGovernor } from '../../src/control/governor.js'
import { MemoryStore, MemoryCheckpoint, type Cache, type Llm } from '../../src/effects/types.js'

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

test('runOpSpec: trace defaults to omitted, returning the bare result unchanged', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  const result = await runOpSpec({
    spec,
    input: { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' },
  }) as { base64: string }
  expect(result.base64).toBeTypeOf('string')
})

test('runOpSpec: trace: true returns { result, trace } with a node-enter/node-exit pair for the leaf', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  const outcome = await runOpSpec({
    spec,
    input: { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' },
    trace: true,
  }) as { result: { base64: string }; trace: Array<{ kind: string; tag: string; name?: string }> }
  expect(Buffer.from(outcome.result.base64, 'base64').toString('utf8')).toBe('a: 1')
  expect(outcome.trace).toEqual([
    expect.objectContaining({ kind: 'node-enter', tag: 'leaf', name: 'convert' }),
    expect.objectContaining({ kind: 'node-exit', tag: 'leaf', name: 'convert', ok: true }),
  ])
})

test('runOpSpec: trace: true still invokes a caller-supplied gOpts.onTrace alongside the collected array', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  const seen: string[] = []
  const outcome = await runOpSpec({
    spec,
    input: { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' },
    trace: true,
  }, { gOpts: { onTrace: (e) => seen.push(e.kind) } }) as { trace: unknown[] }
  expect(seen).toEqual(['node-enter', 'node-exit'])
  expect(outcome.trace).toHaveLength(2)
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

test('runOpSpec: trace: true bails on the TraceEvent count bomb guard for a large map fan-out instead of buffering it all', async () => {
  const { MAX_TRACE_EVENTS } = await import('../../src/adapters/op-run.js')
  // Each item contributes a node-enter/node-exit pair; the map node itself
  // contributes one more pair -- comfortably over MAX_TRACE_EVENTS either way.
  const items = Array.from({ length: Math.ceil(MAX_TRACE_EVENTS / 2) + 1 }, (_, i) => i)
  const spec: OpSpec = { tag: 'map', op: { tag: 'leaf', name: 'shout', opts: { kind: 'pure' } }, concurrency: 16 }
  await expect(runOpSpec(
    { spec, input: items, trace: true },
    { leaves: { shout: async (input) => input } },
  )).rejects.toThrow(/bomb guard/)
})

test('runOpSpec: opts.gOpts.onTrace (the same gOpts bag onEvent already rides) receives node-enter/node-exit for every node the spec visits (#215)', async () => {
  const spec: OpSpec = { tag: 'pipe', steps: [{ tag: 'leaf', name: 'convert' }] }
  const trace: unknown[] = []
  const input = { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' }
  const result = await runOpSpec({ spec, input }, { gOpts: { onTrace: (e) => trace.push(e) } }) as { base64: string }
  expect(Buffer.from(result.base64, 'base64').toString('utf8')).toBe('a: 1')
  expect(trace).toEqual([
    { kind: 'node-enter', tag: 'pipe', name: undefined, path: '', runId: expect.any(String), callId: expect.any(String) },
    { kind: 'node-enter', tag: 'leaf', name: 'convert', path: '0', runId: expect.any(String), callId: expect.any(String) },
    { kind: 'node-exit', tag: 'leaf', name: 'convert', path: '0', runId: expect.any(String), callId: expect.any(String), durationMs: expect.any(Number), ok: true },
    { kind: 'node-exit', tag: 'pipe', name: undefined, path: '', runId: expect.any(String), callId: expect.any(String), durationMs: expect.any(Number), ok: true },
  ])
})

test('runOpSpec: a sink spec resolves the built-in `store` target with no host wiring required, echoing the piped value through', async () => {
  const spec: OpSpec = { tag: 'sink', targets: ['store'] }
  const result = await runOpSpec({ spec, input: { a: 1 } })
  expect(result).toEqual({ a: 1 })
})

test('runOpSpec: opts.sinks lets a host register/override a named target', async () => {
  const written: unknown[] = []
  const spec: OpSpec = { tag: 'sink', targets: ['log'] }
  const result = await runOpSpec(
    { spec, input: { a: 1 } },
    { sinks: { log: { name: 'log', write: async (v) => { written.push(v); return v } } } },
  )
  expect(written).toEqual([{ a: 1 }])
  expect(result).toEqual({ a: 1 })
})

test('runOpSpec: an unknown sink target surfaces an error instead of silently no-oping', async () => {
  const spec: OpSpec = { tag: 'sink', targets: ['nope'] }
  await expect(runOpSpec({ spec, input: {} })).rejects.toThrow()
})

test('runOpSpec: opts.governors persist breaker state across separate calls, not just within one', async () => {
  const governors = { convert: createGovernor('convert', { circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, halfOpenSuccesses: 1 } }) }
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  const failingInput = { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('not json')), type: 'application/json' }, from: 'json', to: 'yaml' }
  await expect(runOpSpec({ spec, input: failingInput }, { governors })).rejects.toThrow()

  const validInput = { handle: { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"a":1}')), type: 'application/json' }, from: 'json', to: 'yaml' }
  await expect(runOpSpec({ spec, input: validInput }, { governors })).rejects.toThrow(/circuit open/)
})

test('runOpSpec: summarize (an LLM-effect leaf) throws by default -- no path to a real Llm capability', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'summarize' }
  const input = { $handle: true, base64: bytesToB64(new TextEncoder().encode('the full text')) }
  await expect(runOpSpec({ spec, input })).rejects.toThrow(/llm capability is not available/)
})

test('runOpSpec: opts.llm lets a host wire a real Llm capability through to the summarize/extract leaves', async () => {
  const llm: Llm = {
    markdownFromPdf: async () => { throw new Error('unused') },
    summarize: async (text) => `summary of ${text}`,
  }
  const spec: OpSpec = { tag: 'leaf', name: 'summarize' }
  const input = { $handle: true, base64: bytesToB64(new TextEncoder().encode('the full text')) }
  const result = await runOpSpec({ spec, input }, { llm }) as { abstract: string; summaryHandle: { base64: string } }
  expect(result.abstract).toBe('summary of the full text')
  expect(Buffer.from(result.summaryHandle.base64, 'base64').toString('utf8')).toBe('summary of the full text')
})

test('runOpSpec: opts.leaves lets a host register a custom leaf a spec can name', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const result = await runOpSpec({ spec, input: { a: 1 } }, { leaves: { shout: async (input) => ({ shouted: input }) } })
  expect(result).toEqual({ shouted: { a: 1 } })
})

test('runOpSpec: an unknown leaf name still surfaces a clear error when opts.leaves is supplied but doesn\'t cover it', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'nope' }
  await expect(runOpSpec({ spec, input: null }, { leaves: { shout: async (input) => input } })).rejects.toThrow(/unknown leaf "nope"/)
})

test('runOpSpec: an ask spec fails without opts.ask (onTimeout: fail), and opts.ask lets a host answer it', async () => {
  const spec: OpSpec = { tag: 'ask', prompt: 'approve?', timeout: '5m', onTimeout: 'fail' }
  await expect(runOpSpec({ spec, input: null })).rejects.toThrow(/ask timed out/)

  const result = await runOpSpec({ spec, input: null }, { ask: { request: async () => ({ answered: true, value: 'approved' }) } })
  expect(result).toBe('approved')
})

test('runOpSpec: a caller-supplied raw Handle object (not a $handle ref) is rejected instead of passed through to the leaf', async () => {
  const store = new MemoryStore()
  const secret = await store.put(new TextEncoder().encode('someone else\'s bytes'), 'application/octet-stream')
  const spec: OpSpec = { tag: 'leaf', name: 'scrub' }
  await expect(runOpSpec({ spec, input: secret }, { store })).rejects.toThrow(/raw Handle object/)
})

test('runOpSpec: a raw Handle object nested inside a larger input (e.g. a {handle, ...opts} leaf shape) is also rejected', async () => {
  const store = new MemoryStore()
  const secret = await store.put(new TextEncoder().encode('{"a":1}'), 'application/json')
  const spec: OpSpec = { tag: 'leaf', name: 'convert' }
  await expect(runOpSpec({ spec, input: { handle: secret, from: 'json', to: 'yaml' } }, { store })).rejects.toThrow(/raw Handle object/)
})

test('runOpSpec: with no opts.checkpoint configured, the response shape is unchanged (no runId leaks in)', async () => {
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const result = await runOpSpec({ spec, input: { a: 1 } }, { leaves: { shout: async (input) => input } })
  expect(result).toEqual({ a: 1 })
})

test('runOpSpec: opts.checkpoint wired in mints and returns a runId when the request omits one, wrapping the result as { result, runId }', async () => {
  const checkpoint = new MemoryCheckpoint()
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const outcome = await runOpSpec(
    { spec, input: { a: 1 } },
    { leaves: { shout: async (input) => input }, checkpoint },
  ) as { result: unknown; runId: string }
  expect(outcome.result).toEqual({ a: 1 })
  expect(outcome.runId).toBeTypeOf('string')
  expect(outcome.runId.length).toBeGreaterThan(0)
})

test('runOpSpec: a second call sharing opts.checkpoint/store and the first call\'s returned runId resumes instead of re-executing a leaf that already finished (#396)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const store = new MemoryStore()
  let calls = 0
  const spec: OpSpec = { tag: 'leaf', name: 'countedLeaf' }
  const leaves = { countedLeaf: async (input: unknown) => { calls++; return input } }

  const first = await runOpSpec({ spec, input: { a: 1 } }, { leaves, checkpoint, store }) as { result: unknown; runId: string }
  expect(first.result).toEqual({ a: 1 })
  expect(calls).toBe(1)

  const second = await runOpSpec({ spec, input: { a: 1 }, runId: first.runId }, { leaves, checkpoint, store }) as { result: unknown; runId: string }
  expect(second.result).toEqual({ a: 1 })
  expect(second.runId).toBe(first.runId)
  // The leaf is never re-invoked -- the resumed call's node was already
  // recorded under (runId, path) by the first call.
  expect(calls).toBe(1)
})

test('runOpSpec: a request reusing another run\'s runId but a different spec does not read that run\'s checkpointed result (#398)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const store = new MemoryStore()
  let calls = 0
  const leaves = {
    victimLeaf: async (input: unknown) => { calls++; return { secret: 'victim-data', input } },
    attackerLeaf: async (input: unknown) => { calls++; return { attacker: true, input } },
  }
  const victimSpec: OpSpec = { tag: 'leaf', name: 'victimLeaf' }
  const first = await runOpSpec({ spec: victimSpec, input: { a: 1 } }, { leaves, checkpoint, store }) as { result: unknown; runId: string }
  expect(first.result).toEqual({ secret: 'victim-data', input: { a: 1 } })
  expect(calls).toBe(1)

  // A different spec at the same structural path (a bare top-level leaf, so
  // both runs' checkpoint entries would land at path '') reusing the
  // victim's returned runId must re-execute, not read the victim's recorded
  // { secret: 'victim-data', ... } value.
  const attackerSpec: OpSpec = { tag: 'leaf', name: 'attackerLeaf' }
  const second = await runOpSpec({ spec: attackerSpec, input: { a: 1 }, runId: first.runId }, { leaves, checkpoint, store }) as { result: unknown; runId: string }
  expect(calls).toBe(2)
  expect(second.result).toEqual({ attacker: true, input: { a: 1 } })
  expect(second.runId).toBe(first.runId)
})

test('runOpSpec: a request reusing another run\'s runId and spec but different input does not read that run\'s checkpointed result (#398)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const store = new MemoryStore()
  let calls = 0
  const leaves = { countedLeaf: async (input: unknown) => { calls++; return { input } } }
  const spec: OpSpec = { tag: 'leaf', name: 'countedLeaf' }
  const first = await runOpSpec({ spec, input: { a: 'victim' } }, { leaves, checkpoint, store }) as { result: unknown; runId: string }
  expect(calls).toBe(1)

  const second = await runOpSpec({ spec, input: { a: 'attacker' }, runId: first.runId }, { leaves, checkpoint, store }) as { result: unknown; runId: string }
  expect(calls).toBe(2)
  expect(second.result).toEqual({ input: { a: 'attacker' } })
})

test('runOpSpec: trace: true plus opts.checkpoint returns { result, trace, runId } together', async () => {
  const checkpoint = new MemoryCheckpoint()
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const outcome = await runOpSpec(
    { spec, input: { a: 1 }, trace: true },
    { leaves: { shout: async (input) => input }, checkpoint },
  ) as { result: unknown; trace: unknown[]; runId: string }
  expect(outcome.result).toEqual({ a: 1 })
  expect(outcome.trace.length).toBeGreaterThan(0)
  expect(outcome.runId).toBeTypeOf('string')
})

test('runOpSpecStatus: reports { done: false } for a runId with no recorded checkpoint entry', async () => {
  const checkpoint = new MemoryCheckpoint()
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const status = await runOpSpecStatus({ spec, input: { a: 1 }, runId: 'never-ran' }, { checkpoint })
  expect(status).toEqual({ done: false })
})

test('runOpSpecStatus: reports { done: true, result } for a finished run, given the same spec/input/runId it ran with (#409)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const spec: OpSpec = { tag: 'leaf', name: 'shout' }
  const first = await runOpSpec(
    { spec, input: { a: 1 } },
    { leaves: { shout: async (input) => input }, checkpoint },
  ) as { result: unknown; runId: string }

  const status = await runOpSpecStatus({ spec, input: { a: 1 }, runId: first.runId }, { checkpoint })
  expect(status).toEqual({ done: true, result: { a: 1 } })
})

test('runOpSpecStatus: dehydrates a Handle-shaped recorded result back to base64 when opts.store is supplied', async () => {
  const checkpoint = new MemoryCheckpoint()
  const store = new MemoryStore()
  const spec: OpSpec = { tag: 'leaf', name: 'unzip' }
  const png = buildMinimalPng()
  const zipBytes = zipSync({ 'a.png': png })
  const first = await runOpSpec(
    { spec, input: { $handle: true, base64: bytesToB64(zipBytes) } },
    { checkpoint, store },
  ) as { result: unknown; runId: string }
  expect(Array.isArray(first.result)).toBe(true)

  const status = await runOpSpecStatus({ spec, input: { $handle: true, base64: bytesToB64(zipBytes) }, runId: first.runId }, { checkpoint, store })
  expect(status.done).toBe(true)
  if (status.done) {
    const results = status.result as Array<{ base64: string; type: string; size: number }>
    expect(results.length).toBe(1)
    expect(results[0].base64).toBeTypeOf('string')
  }
})

test('runOpSpecStatus: a status query naming another run\'s runId but a different spec/input reports { done: false } instead of leaking that run\'s result (#398 guard applied to status queries too)', async () => {
  const checkpoint = new MemoryCheckpoint()
  const victimSpec: OpSpec = { tag: 'leaf', name: 'victimLeaf' }
  const first = await runOpSpec(
    { spec: victimSpec, input: { a: 1 } },
    { leaves: { victimLeaf: async (input) => ({ secret: 'victim-data', input }) }, checkpoint },
  ) as { result: unknown; runId: string }

  const attackerSpec: OpSpec = { tag: 'leaf', name: 'victimLeaf' }
  const status = await runOpSpecStatus({ spec: attackerSpec, input: { a: 'attacker' }, runId: first.runId }, { checkpoint })
  expect(status).toEqual({ done: false })
})
