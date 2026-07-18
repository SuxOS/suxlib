import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerFileopsTools } from '../../src/adapters/mcp.js'
import { MemoryStore } from '../../src/effects/types.js'
import { bytesToB64 } from '../../src/adapters/base64.js'

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
    expect(tools.map((t) => t.name).sort()).toEqual(['archive_create', 'archive_extract', 'pdf_shrink', 'pdf_page_count', 'sanitize_image', 'sanitize_text', 'transform', 'run_pipeline'].sort())
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

  it('run_pipeline: an unknown leaf name surfaces as a tool error, not an uncaught exception', async () => {
    const result = await client.callTool({ name: 'run_pipeline', arguments: { spec: { tag: 'leaf', name: 'nope' }, input: null } })
    expect(result.isError).toBe(true)
  })

  it('run_pipeline: a sink spec resolves the built-in `store` target with no host wiring required, echoing the piped value through', async () => {
    const result = await client.callTool({ name: 'run_pipeline', arguments: { spec: { tag: 'sink', targets: ['store'] }, input: { a: 1 } } })
    expect(result.isError).toBeFalsy()
    expect(parseResult(result)).toEqual({ a: 1 })
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
})
