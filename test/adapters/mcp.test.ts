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

  it('run_pipeline: a `reconcile` spec reaches buildOp through the MCP tool schema, not just HTTP/CLI (unzip -> reconcile field-merge)', async () => {
    const zipMod = await import('fflate')
    const zip = zipMod.zipSync({ 'a.json': new TextEncoder().encode('{"a":1}'), 'b.json': new TextEncoder().encode('{"b":2}') })
    const result = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'unzip' }, { tag: 'reconcile', opts: { mode: 'field-merge' } }] },
        input: { $handle: true, base64: bytesToB64(zip), type: 'application/zip' },
      },
    })
    expect(result.isError).toBeFalsy()
    const body = parseResult(result) as { base64: string }
    expect(JSON.parse(atob(body.base64))).toEqual({ a: 1, b: 2 })
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
})
