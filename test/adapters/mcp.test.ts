import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerFileopsTools } from '../../src/adapters/mcp.js'
import { MemoryStore, MemoryCheckpoint } from '../../src/effects/types.js'
import { b64ToBytes, bytesToB64 } from '../../src/adapters/base64.js'

const b64 = (s: string) => btoa(s)

function parseResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content?.[0]?.text
  return text ? JSON.parse(text) : undefined
}

describe('mcp adapter', () => {
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    server = new McpServer({ name: 'test', version: '0.0.0' })
    registerFileopsTools(server)
    client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it('lists the expected tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['archive_create', 'archive_extract', 'pdf_shrink', 'pdf_page_count', 'sanitize_image', 'sanitize_text', 'transform', 'run_pipeline', 'check_pipeline_status', 'describe_pipeline', 'validate_pipeline', 'plan_pipeline'].sort())
  })

  it('transform: happy path json -> yaml', async () => {
    const result = await client.callTool({ name: 'transform', arguments: { data: '{"a":1}', to: 'yaml' } })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ data: 'a: 1' })
  })

  it('sanitize_text: happy path redacts an email', async () => {
    const result = await client.callTool({ name: 'sanitize_text', arguments: { text: 'contact ada@example.com' } })
    expect(parseResult(result)).toMatchObject({ redacted: 'contact [REDACTED:email]', counts: { email: 1 } })
  })

  it('archive_create + archive_extract: happy-path round trip', async () => {
    const created = await client.callTool({ name: 'archive_create', arguments: { format: 'zip', files: [{ name: 'a.txt', base64: b64('hello') }] } })
    const { base64 } = parseResult(created) as { base64: string }
    const extracted = await client.callTool({ name: 'archive_extract', arguments: { format: 'zip', base64 } })
    const { entries } = parseResult(extracted) as { entries: Array<{ name: string; text?: string }> }
    expect(entries[0]).toMatchObject({ name: 'a.txt', text: 'hello' })
  })

  it('archive_create + archive_extract: threads an explicit per-file mtime through', async () => {
    const mtime = new Date(2022, 4, 17, 10, 30, 0).getTime()
    const created = await client.callTool({ name: 'archive_create', arguments: { format: 'zip', files: [{ name: 'a.txt', base64: b64('hello'), mtime }] } })
    const { base64 } = parseResult(created) as { base64: string }
    const extracted = await client.callTool({ name: 'archive_extract', arguments: { format: 'zip', base64 } })
    const { entries } = parseResult(extracted) as { entries: Array<{ name: string; mtime?: number }> }
    expect(entries[0].mtime).toBe(mtime)
  })

  it('pdf_shrink: happy path shrinks a valid PDF', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([300, 400])
    const bytes = await doc.save()
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    const result = await client.callTool({ name: 'pdf_shrink', arguments: { base64: btoa(s) } })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { mime: string; outputBytes: number }
    expect(body.mime).toBe('application/pdf')
    expect(body.outputBytes).toBeGreaterThan(0)
  })

  it('pdf_page_count: happy path reports the page count', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([300, 400])
    doc.addPage([300, 400])
    const bytes = await doc.save()
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    const result = await client.callTool({ name: 'pdf_page_count', arguments: { base64: btoa(s) } })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ pageCount: 2 })
  })

  it('sanitize_image: malformed image surfaces as a tool error, not an uncaught exception', async () => {
    const result = await client.callTool({ name: 'sanitize_image', arguments: { base64: b64('not an image') } })
    expect(result.isError).toBe(true)
  })

  it('archive_create: rejects more than MAX_ENTRIES files without decoding them', async () => {
    const { MAX_ENTRIES } = await import('../../src/domain/archive.js')
    const files = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt`, base64: b64('x') }))
    const result = await client.callTool({ name: 'archive_create', arguments: { format: 'zip', files } })
    expect(result.isError).toBe(true)
  })

  it('archive_create: bails on the aggregate byte guard instead of decoding every file first', async () => {
    const { MAX_UNPACK_BYTES } = await import('../../src/domain/archive.js')
    const big = 'x'.repeat(Math.ceil(MAX_UNPACK_BYTES / 2) + 1)
    const files = [
      { name: 'a.txt', base64: b64(big) },
      { name: 'b.txt', base64: b64(big) },
      { name: 'c.txt', base64: b64(big) },
    ]
    const result = await client.callTool({ name: 'archive_create', arguments: { format: 'zip', files } })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content?.[0]?.text).toMatch(/bomb guard/)
  })

  it('run_pipeline: happy path runs a single-leaf `convert` spec via the op engine', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: { tag: 'leaf', name: 'convert' },
        input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { base64: string }
    expect(atob(body.base64)).toBe('a: 1')
  })

  it('run_pipeline: trace: true returns a TraceEvent[] trace alongside result', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: { tag: 'leaf', name: 'convert' },
        input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
        trace: true,
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { result: { base64: string }; trace: Array<{ kind: string }> }
    expect(atob(body.result.base64)).toBe('a: 1')
    expect(body.trace.map((e) => e.kind)).toEqual(['node-enter', 'node-exit'])
  })

  it('run_pipeline: trace: \'full\' additionally attaches inputRef/outputRef snapshots', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: { tag: 'leaf', name: 'convert' },
        input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
        trace: 'full',
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { trace: Array<{ kind: string; inputRef?: { base64: string }; outputRef?: { base64: string } }> }
    const enter = body.trace.find((e) => e.kind === 'node-enter')!
    const exit = body.trace.find((e) => e.kind === 'node-exit')!
    expect(enter.inputRef?.base64).toBeTypeOf('string')
    expect(exit.outputRef?.base64).toBeTypeOf('string')
  })

  it('run_pipeline: streams live per-node progress notifications when the client requests one via progressToken', async () => {
    const progress: number[] = []
    const result = await client.callTool(
      {
        name: 'run_pipeline',
        arguments: {
          spec: { tag: 'leaf', name: 'convert' },
          input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
        },
      },
      undefined,
      { onprogress: (p) => progress.push(p.progress) },
    )
    expect(result.isError).toBeFalsy()
    expect(progress.length).toBeGreaterThan(0)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('run_pipeline: a leaf spec\'s `params` reach the leaf through the MCP tool schema, not just buildOp directly (unzip -> map(wrapHandle, convert))', async () => {
    const zipMod = await import('fflate')
    const zip = zipMod.zipSync({ 'a.json': new TextEncoder().encode('{"a":1}') })
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: {
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
        },
        input: { $handle: true, base64: bytesToB64(zip), type: 'application/zip' },
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as Array<{ base64: string }>
    expect(atob(body[0].base64)).toBe('a: 1')
  })

  it('run_pipeline: a map spec\'s `{ kind: \'aimd\' }` concurrency reaches buildOp through the MCP tool schema, not just a plain-number fixed() concurrency (#195)', async () => {
    const zipMod = await import('fflate')
    const zip = zipMod.zipSync({ 'a.txt': new TextEncoder().encode('hello'), 'b.txt': new TextEncoder().encode('world') })
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: {
          tag: 'pipe',
          steps: [
            { tag: 'leaf', name: 'unzip' },
            { tag: 'map', op: { tag: 'leaf', name: 'stamp' }, concurrency: { kind: 'aimd', start: 2, min: 1, max: 4 } },
          ],
        },
        input: { $handle: true, base64: bytesToB64(zip), type: 'application/zip' },
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as Array<{ base64: string }>
    expect(body).toHaveLength(2)
    expect([atob(body[0].base64), atob(body[1].base64)].sort()).toEqual(['hello', 'world'])
  })

  it('run_pipeline: an unknown leaf name surfaces as a tool error, not an uncaught exception', async () => {
    const result = await client.callTool({ name: 'run_pipeline', arguments: { spec: { tag: 'leaf', name: 'nope' }, input: null } })
    expect(result.isError).toBe(true)
  })

  it('run_pipeline: a sink spec resolves the built-in `store` target with no host wiring required, echoing the piped value through', async () => {
    const result = await client.callTool({ name: 'run_pipeline', arguments: { spec: { tag: 'sink', targets: ['store'] }, input: { a: 1 } } })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ a: 1 })
  })

  it('run_pipeline: a mapField spec reaches buildOp through the MCP tool schema (not silently stripped), bridging unpack\'s `entries` into pack\'s `files` (#168)', async () => {
    const zipMod = await import('fflate')
    const zip = zipMod.zipSync({ 'a.txt': new TextEncoder().encode('hello') })
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: {
          tag: 'pipe',
          steps: [
            { tag: 'leaf', name: 'wrapHandle' },
            { tag: 'leaf', name: 'unpack', params: { format: 'zip' } },
            { tag: 'mapField', arrayField: 'entries', elementField: 'handle', op: { tag: 'leaf', name: 'stamp' }, concurrency: 2, renameTo: 'files' },
            { tag: 'leaf', name: 'pack', params: { format: 'zip' } },
          ],
        },
        input: { $handle: true, base64: bytesToB64(zip), type: 'application/zip' },
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { base64: string }
    const unzipped = zipMod.unzipSync(b64ToBytes(body.base64))
    expect(new TextDecoder().decode(unzipped['a.txt'])).toBe('hello')
  })

  it('run_pipeline: a reconcile spec reaches buildOp through the MCP tool schema (not silently stripped)', async () => {
    const input = [
      { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"x":1}')), type: 'application/json' },
      { $handle: true, base64: bytesToB64(new TextEncoder().encode('{"x":2,"y":3}')), type: 'application/json' },
    ]
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: { spec: { tag: 'reconcile', opts: { mode: 'field-merge', defaultPolicy: 'last-write-wins' } }, input },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { base64: string }
    expect(JSON.parse(atob(body.base64))).toEqual({ x: 2, y: 3 })
  })

  it('run_pipeline: a catch spec reaches buildOp through the MCP tool schema (not silently stripped), falling back to a secondary sink when the try branch\'s leaf throws at run time (#183)', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        // unwrapHandle throws on a plain object with no `handle` field, exercising the catch fallback
        spec: { tag: 'catch', try: { tag: 'leaf', name: 'unwrapHandle' }, catch: { tag: 'sink', targets: ['store'] } },
        input: { a: 1 },
      },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ a: 1 })
  })

  it('run_pipeline: a cond spec reaches buildOp through the MCP tool schema (not silently stripped), routing on the piped value (#196)', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: {
          tag: 'cond',
          cases: [{ when: { field: 'kind', equals: 'a' }, then: { tag: 'leaf', name: 'unwrapHandle' } }],
          default: { tag: 'sink', targets: ['store'] },
        },
        input: { kind: 'z', a: 1 },
      },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ kind: 'z', a: 1 })
  })

  it('run_pipeline: a parallel spec reaches buildOp through the MCP tool schema (not silently stripped), fanning one input into N branches (#289)', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: {
          tag: 'parallel',
          ops: [{ tag: 'sink', targets: ['store'] }, { tag: 'sink', targets: ['store'] }],
        },
        input: { a: 1 },
      },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual([{ a: 1 }, { a: 1 }])
  })

  it('run_pipeline: a race spec reaches buildOp through the MCP tool schema (not silently stripped), settling once `need` branches succeed (#429)', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: {
          tag: 'race',
          ops: [{ tag: 'sink', targets: ['store'] }, { tag: 'sink', targets: ['store'] }],
          need: 2,
        },
        input: { a: 1 },
      },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual([{ a: 1 }, { a: 1 }])
  })

  it('run_pipeline: an ask spec reaches buildOp through the MCP tool schema (not silently stripped), degrading gracefully with no Ask capability wired (#181)', async () => {
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: { spec: { tag: 'ask', prompt: 'approve?', timeout: '5m', onTimeout: 'proceed' }, input: { a: 1 } },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ a: 1 })
  })

  it('describe_pipeline: reports the built-in leaf registry, sink targets, reconcile modes, and field policies', async () => {
    const result = await client.callTool({ name: 'describe_pipeline', arguments: {} })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { leaves: Record<string, unknown>; sinks: string[]; reconcileModes: string[]; fieldPolicies: string[] }
    expect(Object.keys(body.leaves)).toContain('convert')
    expect(body.sinks).toEqual(['store'])
    expect(body.reconcileModes).toContain('field-merge')
    expect(body.fieldPolicies).toContain('union')
  })

  it('validate_pipeline: a well-formed spec reports valid with no errors, without running it', async () => {
    const result = await client.callTool({
      name: 'validate_pipeline',
      arguments: { spec: { tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } } },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ valid: true, errors: [] })
  })

  it('validate_pipeline: collects every structural error in one pass instead of stopping at the first (#208)', async () => {
    // Two distinct unknown-leaf errors, not an out-of-range retries/concurrency
    // (the MCP tool's own zod inputSchema already range-checks those before a
    // call ever reaches this handler, unlike an unknown leaf name -- opSpecSchema
    // only requires `name` be a string, see CLAUDE.md's OpSpec-validation
    // footgun note about buildOp/opSpecSchema being two separate layers).
    const result = await client.callTool({
      name: 'validate_pipeline',
      arguments: { spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'nope-1' }, { tag: 'leaf', name: 'nope-2' }] } },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { valid: boolean; errors: Array<{ path: string; message: string }> }
    expect(body.valid).toBe(false)
    expect(body.errors.some((e) => /unknown leaf "nope-1"/.test(e.message))).toBe(true)
    expect(body.errors.some((e) => /unknown leaf "nope-2"/.test(e.message))).toBe(true)
  })

  it('validate_pipeline: reports an aimd concurrency spec\'s `min` exceeding `max` -- a cross-field check the tool\'s own zod schema doesn\'t enforce, so it must reach buildOp\'s own validation (#195)', async () => {
    const result = await client.callTool({
      name: 'validate_pipeline',
      arguments: { spec: { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: { kind: 'aimd', min: 10, max: 2 } } },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { valid: boolean; errors: Array<{ path: string; message: string }> }
    expect(body.valid).toBe(false)
    expect(body.errors.some((e) => /`min` cannot exceed `max`/.test(e.message))).toBe(true)
  })

  it('plan_pipeline: reports a non-executing cost/capability audit (#361)', async () => {
    const result = await client.callTool({
      name: 'plan_pipeline',
      arguments: { spec: { tag: 'map', op: { tag: 'leaf', name: 'extract' }, concurrency: 3 } },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { nodeCount: number; maxConcurrency: number; usesLlm: boolean; llmLeaves: string[] }
    expect(body.nodeCount).toBe(2)
    expect(body.maxConcurrency).toBe(3)
    expect(body.usesLlm).toBe(true)
    expect(body.llmLeaves).toEqual(['extract'])
  })

  it('plan_pipeline: reports an aimd concurrency spec\'s own `max` as the concurrency bound (#195)', async () => {
    const result = await client.callTool({
      name: 'plan_pipeline',
      arguments: { spec: { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: { kind: 'aimd', start: 2, min: 1, max: 16 } } },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { maxConcurrency: number }
    expect(body.maxConcurrency).toBe(16)
  })
})

describe('mcp adapter: allow-listed registration', () => {
  it('registers only the named tools when opts.allow is passed', async () => {
    const scopedServer = new McpServer({ name: 'test-scoped', version: '0.0.0' })
    registerFileopsTools(scopedServer, { allow: ['transform', 'sanitize_text'] })
    const scopedClient = new Client({ name: 'test-scoped-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([scopedServer.connect(serverTransport), scopedClient.connect(clientTransport)])

    const { tools } = await scopedClient.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['sanitize_text', 'transform'])

    await scopedClient.close()
    await scopedServer.close()
  })
})

describe('mcp adapter: persistent op-run cache/governors', () => {
  it('run_pipeline reuses opts.opRunCache across separate tool calls, so a memo leaf runs only once', async () => {
    let puts = 0
    const backing = new Map<string, unknown>()
    const cachedServer = new McpServer({ name: 'test-cached', version: '0.0.0' })
    // opRunStore must be shared alongside opRunCache: the cached result is
    // Handle-shaped, and a Handle only resolves against the Store that
    // produced it -- otherwise the second call's cache hit would fail to
    // dehydrate against its own fresh per-call MemoryStore.
    registerFileopsTools(cachedServer, {
      opRunCache: {
        async get(key) { return backing.get(key) },
        async put(key, value) { puts++; backing.set(key, value) },
      },
      opRunStore: new MemoryStore(),
    })
    const cachedClient = new Client({ name: 'test-cached-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([cachedServer.connect(serverTransport), cachedClient.connect(clientTransport)])

    const args = {
      spec: { tag: 'leaf', name: 'convert', opts: { memo: true } },
      input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
    }
    await cachedClient.callTool({ name: 'run_pipeline', arguments: args })
    await cachedClient.callTool({ name: 'run_pipeline', arguments: args })
    expect(puts).toBe(1)

    await cachedClient.close()
    await cachedServer.close()
  })

  it('run_pipeline: opts.opRunSinks registers a host-supplied sink target', async () => {
    const written: unknown[] = []
    const sinkServer = new McpServer({ name: 'test-sinks', version: '0.0.0' })
    registerFileopsTools(sinkServer, { opRunSinks: { log: { name: 'log', write: async (v) => { written.push(v); return v } } } })
    const sinkClient = new Client({ name: 'test-sinks-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([sinkServer.connect(serverTransport), sinkClient.connect(clientTransport)])

    const result = await sinkClient.callTool({ name: 'run_pipeline', arguments: { spec: { tag: 'sink', targets: ['log'] }, input: { a: 1 } } })
    expect(result.isError).toBeFalsy()
    expect(written).toEqual([{ a: 1 }])

    await sinkClient.close()
    await sinkServer.close()
  })

  it('run_pipeline: a sink spec\'s opts.retries reaches buildOp through the MCP tool schema (not silently stripped), retrying a flaky write (#247)', async () => {
    let calls = 0
    const flakyServer = new McpServer({ name: 'test-flaky-sink', version: '0.0.0' })
    registerFileopsTools(flakyServer, { opRunSinks: { flaky: { name: 'flaky', write: async (v) => { calls++; if (calls < 2) throw new Error('flaky'); return v } } } })
    const flakyClient = new Client({ name: 'test-flaky-sink-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flakyServer.connect(serverTransport), flakyClient.connect(clientTransport)])

    const result = await flakyClient.callTool({
      name: 'run_pipeline',
      arguments: { spec: { tag: 'sink', targets: ['flaky'], opts: { retries: 1 } }, input: { a: 1 } },
    })
    expect(result.isError).toBeFalsy()
    expect(calls).toBe(2)

    await flakyClient.close()
    await flakyServer.close()
  })

  it('run_pipeline: a sink spec\'s per-target `{ name, opts }` pair reaches buildOp through the MCP tool schema (not silently stripped), overriding the fanout-level opts.retries (#251)', async () => {
    let logCalls = 0; let vaultCalls = 0
    const fanoutServer = new McpServer({ name: 'test-fanout-sink', version: '0.0.0' })
    registerFileopsTools(fanoutServer, {
      opRunSinks: {
        log: { name: 'log', write: async (v) => { logCalls++; if (logCalls < 3) throw new Error('flaky'); return v } },
        vault: { name: 'vault', write: async () => { vaultCalls++; throw new Error('flaky') } },
      },
    })
    const fanoutClient = new Client({ name: 'test-fanout-sink-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([fanoutServer.connect(serverTransport), fanoutClient.connect(clientTransport)])

    const result = await fanoutClient.callTool({
      name: 'run_pipeline',
      arguments: { spec: { tag: 'sink', targets: ['log', { name: 'vault', opts: { retries: 0 } }], opts: { retries: 3 } }, input: { a: 1 } },
    })
    expect(result.isError).toBeTruthy()
    expect(logCalls).toBe(3)
    expect(vaultCalls).toBe(1)

    await fanoutClient.close()
    await fanoutServer.close()
  })

  it('run_pipeline: opts.opRunLlm wires a real Llm capability through to the summarize leaf', async () => {
    const llmServer = new McpServer({ name: 'test-llm', version: '0.0.0' })
    registerFileopsTools(llmServer, { opRunLlm: { markdownFromPdf: async () => { throw new Error('unused') }, summarize: async (text) => `summary of ${text}` } })
    const llmClient = new Client({ name: 'test-llm-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([llmServer.connect(serverTransport), llmClient.connect(clientTransport)])

    const result = await llmClient.callTool({
      name: 'run_pipeline',
      arguments: { spec: { tag: 'leaf', name: 'summarize' }, input: { $handle: true, base64: b64('the full text') } },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toMatchObject({ abstract: 'summary of the full text' })

    await llmClient.close()
    await llmServer.close()
  })

  it('run_pipeline: opts.opRunAsk wires a real Ask capability through to an ask step', async () => {
    const askServer = new McpServer({ name: 'test-ask', version: '0.0.0' })
    registerFileopsTools(askServer, { opRunAsk: { request: async () => ({ answered: true, value: 'human answer' }) } })
    const askClient = new Client({ name: 'test-ask-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([askServer.connect(serverTransport), askClient.connect(clientTransport)])

    const result = await askClient.callTool({
      name: 'run_pipeline',
      arguments: { spec: { tag: 'ask', prompt: 'pick one', timeout: '10s', onTimeout: 'fail' }, input: 'default' },
    })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toBe('human answer')

    await askClient.close()
    await askServer.close()
  })

  it('run_pipeline: opts.opRunLeaves lets a host register a custom leaf a spec can name', async () => {
    const leavesServer = new McpServer({ name: 'test-leaves', version: '0.0.0' })
    registerFileopsTools(leavesServer, { opRunLeaves: { shout: async (input) => ({ shouted: input }) } })
    const leavesClient = new Client({ name: 'test-leaves-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([leavesServer.connect(serverTransport), leavesClient.connect(clientTransport)])

    const result = await leavesClient.callTool({ name: 'run_pipeline', arguments: { spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 } } })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ shouted: { a: 1 } })

    await leavesClient.close()
    await leavesServer.close()
  })

  it('run_pipeline: a mid-flight MCP cancellation stops the next pipe step from running on the server (#279)', async () => {
    const abortServer = new McpServer({ name: 'test-abort', version: '0.0.0' })
    let secondRan = false
    registerFileopsTools(abortServer, {
      opRunLeaves: {
        pauseThenContinue: async (input) => { await new Promise(resolve => setTimeout(resolve, 20)); return input },
        neverRuns: async (input) => { secondRan = true; return input },
      },
    })
    const abortClient = new Client({ name: 'test-abort-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([abortServer.connect(serverTransport), abortClient.connect(clientTransport)])

    const controller = new AbortController()
    const callPromise = abortClient.callTool(
      { name: 'run_pipeline', arguments: { spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'pauseThenContinue' }, { tag: 'leaf', name: 'neverRuns' }] }, input: { a: 1 } } },
      undefined,
      { signal: controller.signal },
    )
    await new Promise(resolve => setTimeout(resolve, 5)) // let the request reach the server and enter the first leaf
    controller.abort() // client-side: rejects callPromise and sends a cancellation notification to the server
    await callPromise.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30)) // give the server's in-flight run time to observe extra.signal and stop
    expect(secondRan).toBe(false)

    await abortClient.close()
    await abortServer.close()
  })

  it('run_pipeline\'s tool description lists opts.opRunLeaves-registered leaves alongside the built-in registry (#158)', async () => {
    const leavesServer = new McpServer({ name: 'test-leaves-desc', version: '0.0.0' })
    registerFileopsTools(leavesServer, { opRunLeaves: { shout: async (input) => input } })
    const leavesClient = new Client({ name: 'test-leaves-desc-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([leavesServer.connect(serverTransport), leavesClient.connect(clientTransport)])

    const { tools } = await leavesClient.listTools()
    const runPipeline = tools.find((t) => t.name === 'run_pipeline')
    expect(runPipeline?.description).toContain('shout')
    expect(runPipeline?.description).toContain('convert')

    await leavesClient.close()
    await leavesServer.close()
  })

  it('run_pipeline\'s tool description lists opts.opRunSinks-registered sink targets alongside the built-in registry (#166)', async () => {
    const sinksServer = new McpServer({ name: 'test-sinks-desc', version: '0.0.0' })
    registerFileopsTools(sinksServer, { opRunSinks: { log: { name: 'log', write: async (v) => v } } })
    const sinksClient = new Client({ name: 'test-sinks-desc-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([sinksServer.connect(serverTransport), sinksClient.connect(clientTransport)])

    const { tools } = await sinksClient.listTools()
    const runPipeline = tools.find((t) => t.name === 'run_pipeline')
    expect(runPipeline?.description).toContain('log')
    expect(runPipeline?.description).toContain('store')

    await sinksClient.close()
    await sinksServer.close()
  })

  it('describe_pipeline reports opts.opRunLeaves/opRunSinks-registered names alongside the built-in registry', async () => {
    const describeServer = new McpServer({ name: 'test-describe', version: '0.0.0' })
    registerFileopsTools(describeServer, {
      opRunLeaves: { shout: async (input) => input },
      opRunSinks: { log: { name: 'log', write: async (v) => v } },
    })
    const describeClient = new Client({ name: 'test-describe-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([describeServer.connect(serverTransport), describeClient.connect(clientTransport)])

    const result = await describeClient.callTool({ name: 'describe_pipeline', arguments: {} })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { leaves: Record<string, unknown>; sinks: string[] }
    expect(Object.keys(body.leaves)).toContain('shout')
    expect(body.sinks).toContain('log')

    const validated = await describeClient.callTool({ name: 'validate_pipeline', arguments: { spec: { tag: 'leaf', name: 'shout' } } })
    expect(parseResult(validated)).toEqual({ valid: true, errors: [] })

    await describeClient.close()
    await describeServer.close()
  })
})

describe('mcp adapter: check_pipeline_status (#409)', () => {
  let client: Client
  let server: McpServer

  beforeEach(async () => {
    server = new McpServer({ name: 'test-no-checkpoint', version: '0.0.0' })
    registerFileopsTools(server)
    client = new Client({ name: 'test-no-checkpoint-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  it('requires opts.opRunCheckpoint to be configured', async () => {
    const result = await client.callTool({
      name: 'check_pipeline_status',
      arguments: { spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 }, runId: 'x' },
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content?.[0]?.text).toMatch(/opRunCheckpoint/)
  })

  it('reports { done: false } for a runId with no recorded checkpoint entry, and { done: true, result } once run_pipeline has finished', async () => {
    const checkpointServer = new McpServer({ name: 'test-checkpoint', version: '0.0.0' })
    registerFileopsTools(checkpointServer, { opRunCheckpoint: new MemoryCheckpoint(), opRunLeaves: { shout: async (input) => input } })
    const checkpointClient = new Client({ name: 'test-checkpoint-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([checkpointServer.connect(serverTransport), checkpointClient.connect(clientTransport)])

    const spec = { tag: 'leaf', name: 'shout' }
    const neverRan = await checkpointClient.callTool({ name: 'check_pipeline_status', arguments: { spec, input: { a: 1 }, runId: 'never-ran' } })
    expect(parseResult(neverRan)).toEqual({ done: false, started: false })

    const runResult = await checkpointClient.callTool({ name: 'run_pipeline', arguments: { spec, input: { a: 1 } } })
    const { runId } = parseResult(runResult) as { runId: string }

    const status = await checkpointClient.callTool({ name: 'check_pipeline_status', arguments: { spec, input: { a: 1 }, runId } })
    expect(parseResult(status)).toEqual({ done: true, result: { a: 1 } })

    await checkpointClient.close()
    await checkpointServer.close()
  })
})
