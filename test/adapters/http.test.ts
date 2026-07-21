import { describe, expect, it } from 'vitest'
import handler, { type Env } from '../../src/adapters/http.js'
import { MemoryStore, MemoryCheckpoint } from '../../src/effects/types.js'

function post(path: string, body: unknown, headers: Record<string, string> = {}, env?: Env): Promise<Response> {
  return handler.fetch(
    new Request(`https://fileops.example/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  )
}

const b64 = (s: string) => btoa(s)

describe('http adapter', () => {
  it('GET / lists the routes', async () => {
    const res = await handler.fetch(new Request('https://fileops.example/'))
    const body = (await res.json()) as { ok: boolean; routes: string[] }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.routes).toContain('POST /transform')
  })

  it('404s an unknown route', async () => {
    const res = await handler.fetch(new Request('https://fileops.example/nope'))
    expect(res.status).toBe(404)
  })

  it('env.allowRoutes restricts both GET / listing and routing to the given subset', async () => {
    const env: Env = { allowRoutes: ['/transform'] }
    const list = await handler.fetch(new Request('https://fileops.example/'), env)
    const body = (await list.json()) as { routes: string[] }
    expect(body.routes).toEqual(['POST /transform'])

    const allowed = await post('transform', { data: '{"a":1}', to: 'yaml' }, {}, env)
    expect(allowed.status).toBe(200)

    const blocked = await post('sanitize/text', { text: 'a@b.com' }, {}, env)
    expect(blocked.status).toBe(404)
  })

  it('POST /transform: happy path json -> yaml', async () => {
    const res = await post('transform', { data: '{"a":1}', to: 'yaml' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: string }
    expect(body.data).toBe('a: 1')
  })

  it('POST /transform: malformed input surfaces a 400, not a 500', async () => {
    const res = await post('transform', { data: '{not valid json', from: 'json', to: 'yaml' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })

  it('POST /transform: an invalid `from` surfaces a 400, not a silent 200 with an empty body', async () => {
    const res = await post('transform', { data: 'foo', from: 'bogus', to: 'json' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })

  it('POST /transform: an invalid `to` surfaces a 400', async () => {
    const res = await post('transform', { data: '{"a":1}', to: 'bogus' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })

  it('POST /archive/create + /archive/extract: happy-path round trip', async () => {
    const createRes = await post('archive/create', { format: 'zip', files: [{ name: 'a.txt', base64: b64('hello') }] })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as { base64: string }
    const extractRes = await post('archive/extract', { format: 'zip', base64: created.base64 })
    const extracted = (await extractRes.json()) as { entries: Array<{ name: string; text?: string }> }
    expect(extracted.entries[0]).toMatchObject({ name: 'a.txt', text: 'hello' })
  })

  it('POST /archive/create + /archive/extract: threads an explicit per-file mtime through', async () => {
    const mtime = new Date(2022, 4, 17, 10, 30, 0).getTime()
    const createRes = await post('archive/create', { format: 'zip', files: [{ name: 'a.txt', base64: b64('hello'), mtime }] })
    const created = (await createRes.json()) as { base64: string }
    const extractRes = await post('archive/extract', { format: 'zip', base64: created.base64 })
    const extracted = (await extractRes.json()) as { entries: Array<{ name: string; mtime?: number }> }
    expect(extracted.entries[0].mtime).toBe(mtime)
  })

  it('POST /archive/create + /archive/extract: happy-path round trip for tar.gz', async () => {
    const createRes = await post('archive/create', { format: 'tar.gz', files: [{ name: 'a.txt', base64: b64('hello') }] })
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as { base64: string }
    const extractRes = await post('archive/extract', { format: 'tar.gz', base64: created.base64 })
    const extracted = (await extractRes.json()) as { entries: Array<{ name: string; text?: string }> }
    expect(extracted.entries[0]).toMatchObject({ name: 'a.txt', text: 'hello' })
  })

  it('POST /archive/create: duplicate entry names surface a clean 400, not a 500', async () => {
    const res = await post('archive/create', { format: 'zip', files: [{ name: 'dup.txt', base64: b64('1') }, { name: 'dup.txt', base64: b64('2') }] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/duplicate/i)
  })

  it('POST /archive/create: a non-numeric mtime surfaces a clean 400, not a corrupted archive', async () => {
    const res = await post('archive/create', { format: 'zip', files: [{ name: 'a.txt', base64: b64('hi'), mtime: 'oops' }] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/mtime/i)
  })

  it('POST /pdf/shrink: happy path round-trips a valid PDF as base64', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([300, 400])
    const pdfBytes = await doc.save()
    let s = ''
    for (const b of pdfBytes) s += String.fromCharCode(b)
    const res = await post('pdf/shrink', { base64: btoa(s) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mime: string; outputBytes: number }
    expect(body.mime).toBe('application/pdf')
    expect(body.outputBytes).toBeGreaterThan(0)
  })

  it('POST /pdf/page-count: happy path reports the page count', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([300, 400])
    doc.addPage([300, 400])
    const pdfBytes = await doc.save()
    let s = ''
    for (const b of pdfBytes) s += String.fromCharCode(b)
    const res = await post('pdf/page-count', { base64: btoa(s) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pageCount: number }
    expect(body.pageCount).toBe(2)
  })

  it('POST /sanitize/text: happy path redacts an email', async () => {
    const res = await post('sanitize/text', { text: 'contact ada@example.com' })
    const body = (await res.json()) as { redacted: string; counts: Record<string, number> }
    expect(body.redacted).toBe('contact [REDACTED:email]')
    expect(body.counts.email).toBe(1)
  })

  it('POST /sanitize/text: an invalid `types` entry surfaces a 400 instead of a silent no-op redaction', async () => {
    const res = await post('sanitize/text', { text: 'contact ada@example.com', types: ['emial'] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBeTruthy()
  })

  it('POST with a Content-Length over the cap is rejected with 413 before the body is parsed', async () => {
    const res = await handler.fetch(
      new Request('https://fileops.example/sanitize/text', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(50_000_001) },
        body: JSON.stringify({ text: 'small body, oversized header' }),
      }),
    )
    expect(res.status).toBe(413)
  })

  it('no FILEOPS_AUTH_TOKEN configured stays open (documented default)', async () => {
    const res = await post('transform', { data: '{"a":1}', to: 'yaml' })
    expect(res.status).toBe(200)
  })

  it('FILEOPS_AUTH_TOKEN configured rejects a missing/wrong bearer token and accepts the right one', async () => {
    const env = { FILEOPS_AUTH_TOKEN: 's3cret' }
    expect((await post('transform', { data: '{"a":1}', to: 'yaml' }, {}, env)).status).toBe(401)
    expect((await post('transform', { data: '{"a":1}', to: 'yaml' }, { authorization: 'Bearer wrong' }, env)).status).toBe(401)
    expect((await post('transform', { data: '{"a":1}', to: 'yaml' }, { authorization: 'Bearer s3cret' }, env)).status).toBe(200)
  })

  it('POST /op/run: happy path runs a single-leaf `convert` spec via the op engine', async () => {
    const res = await post('op/run', {
      spec: { tag: 'leaf', name: 'convert' },
      input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { base64: string } }
    expect(atob(body.result.base64)).toBe('a: 1')
  })

  it('POST /op/run: trace: true returns a TraceEvent[] trace alongside result', async () => {
    const res = await post('op/run', {
      spec: { tag: 'leaf', name: 'convert' },
      input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
      trace: true,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { base64: string }; trace: Array<{ kind: string }> }
    expect(atob(body.result.base64)).toBe('a: 1')
    expect(body.trace.map((e) => e.kind)).toEqual(['node-enter', 'node-exit'])
  })

  it('POST /op/run: trace: \'full\' additionally attaches inputRef/outputRef snapshots', async () => {
    const res = await post('op/run', {
      spec: { tag: 'leaf', name: 'convert' },
      input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
      trace: 'full',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { trace: Array<{ kind: string; inputRef?: { base64: string }; outputRef?: { base64: string } }> }
    const enter = body.trace.find((e) => e.kind === 'node-enter')!
    const exit = body.trace.find((e) => e.kind === 'node-exit')!
    expect(enter.inputRef?.base64).toBeTypeOf('string')
    expect(exit.outputRef?.base64).toBeTypeOf('string')
  })

  it('POST /op/run: an unknown leaf name in the spec surfaces a 400, not a 500', async () => {
    const res = await post('op/run', { spec: { tag: 'leaf', name: 'nope' }, input: null })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown leaf "nope"/)
  })

  it('POST /op/run: a missing `spec` surfaces a 400', async () => {
    const res = await post('op/run', { input: null })
    expect(res.status).toBe(400)
  })

  it('POST /op/run: a sink spec resolves the built-in `store` target with no host wiring required, echoing the piped value through', async () => {
    const res = await post('op/run', { spec: { tag: 'sink', targets: ['store'] }, input: { a: 1 } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { a: number } }
    expect(body.result).toEqual({ a: 1 })
  })

  it('POST /op/run: env.opRunSinks registers a host-supplied sink target', async () => {
    const written: unknown[] = []
    const env: Env = { opRunSinks: { log: { name: 'log', write: async (v) => { written.push(v); return v } } } }
    const res = await post('op/run', { spec: { tag: 'sink', targets: ['log'] }, input: { a: 1 } }, {}, env)
    expect(res.status).toBe(200)
    expect(written).toEqual([{ a: 1 }])
  })

  it('POST /op/run: env.opRunCache is reused across requests, so a memo leaf runs only once for the same input', async () => {
    let puts = 0
    const backing = new Map<string, unknown>()
    // opRunStore must be shared alongside opRunCache: the cached result is
    // Handle-shaped, and a Handle only resolves against the Store that
    // produced it -- otherwise the second request's cache hit would fail to
    // dehydrate against its own fresh per-request MemoryStore.
    const env: Env = {
      opRunCache: {
        async get(key) { return backing.get(key) },
        async put(key, value) { puts++; backing.set(key, value) },
      },
      opRunStore: new MemoryStore(),
    }
    const body = {
      spec: { tag: 'leaf', name: 'convert', opts: { memo: true } },
      input: { handle: { $handle: true, base64: b64('{"a":1}'), type: 'application/json' }, from: 'json', to: 'yaml' },
    }
    await post('op/run', body, {}, env)
    await post('op/run', body, {}, env)
    expect(puts).toBe(1)
  })

  it('POST /op/run: summarize throws with no env.opRunLlm supplied', async () => {
    const res = await post('op/run', { spec: { tag: 'leaf', name: 'summarize' }, input: { $handle: true, base64: b64('the full text') } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/llm capability is not available/)
  })

  it('POST /op/run: env.opRunLlm wires a real Llm capability through to the summarize leaf', async () => {
    const env: Env = { opRunLlm: { markdownFromPdf: async () => { throw new Error('unused') }, summarize: async (text) => `summary of ${text}` } }
    const res = await post('op/run', { spec: { tag: 'leaf', name: 'summarize' }, input: { $handle: true, base64: b64('the full text') } }, {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { abstract: string } }
    expect(body.result.abstract).toBe('summary of the full text')
  })

  it('POST /op/run: env.opRunAsk wires a real Ask capability through to an ask step', async () => {
    const env: Env = { opRunAsk: { request: async () => ({ answered: true, value: 'human answer' }) } }
    const res = await post('op/run', { spec: { tag: 'ask', prompt: 'pick one', timeout: '10s', onTimeout: 'fail' }, input: 'default' }, {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: string }
    expect(body.result).toBe('human answer')
  })

  it('POST /op/run: env.opRunLeaves lets a host register a custom leaf a spec can name', async () => {
    const env: Env = { opRunLeaves: { shout: async (input) => ({ shouted: input }) } }
    const res = await post('op/run', { spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 } }, {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { shouted: { a: number } } }
    expect(body.result.shouted).toEqual({ a: 1 })
  })

  it('POST /op/run: the request\'s own AbortSignal cancels the run cooperatively, stopping the next pipe step (#279)', async () => {
    const controller = new AbortController()
    const env: Env = { opRunLeaves: { abortNow: async (input) => { controller.abort(); return input } } }
    let secondRan = false
    env.opRunLeaves!.neverRuns = async (input) => { secondRan = true; return input }
    const res = await handler.fetch(new Request('https://fileops.example/op/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'abortNow' }, { tag: 'leaf', name: 'neverRuns' }] }, input: { a: 1 } }),
      signal: controller.signal,
    }), env)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/aborted/)
    expect(secondRan).toBe(false)
  })

  it('POST /op/run/status: requires env.opRunCheckpoint to be configured', async () => {
    const res = await post('op/run/status', { spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 }, runId: 'x' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/opRunCheckpoint/)
  })

  it('POST /op/run/status: reports { done: false } for a runId with no recorded checkpoint entry', async () => {
    const env: Env = { opRunCheckpoint: new MemoryCheckpoint() }
    const res = await post('op/run/status', { spec: { tag: 'leaf', name: 'shout' }, input: { a: 1 }, runId: 'never-ran' }, {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ done: false })
  })

  it('POST /op/run/status: reports { done: true, result } for a finished checkpointed run (#409)', async () => {
    const env: Env = { opRunCheckpoint: new MemoryCheckpoint(), opRunLeaves: { shout: async (input) => input } }
    const spec = { tag: 'leaf', name: 'shout' }
    const runRes = await post('op/run', { spec, input: { a: 1 } }, {}, env)
    const { runId } = (await runRes.json()) as { runId: string }

    const statusRes = await post('op/run/status', { spec, input: { a: 1 }, runId }, {}, env)
    expect(statusRes.status).toBe(200)
    expect(await statusRes.json()).toEqual({ done: true, result: { a: 1 } })
  })

  it('GET /op/schema: reports the built-in leaf registry, sink targets, reconcile modes, and field policies', async () => {
    const res = await handler.fetch(new Request('https://fileops.example/op/schema'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { leaves: Record<string, unknown>; sinks: string[]; reconcileModes: string[]; fieldPolicies: string[] }
    expect(Object.keys(body.leaves)).toContain('convert')
    expect(body.sinks).toEqual(['store'])
    expect(body.reconcileModes).toContain('field-merge')
    expect(body.fieldPolicies).toContain('union')
  })

  it('GET /op/schema: reports env.opRunLeaves/opRunSinks-registered names alongside the built-in registry', async () => {
    const env: Env = { opRunLeaves: { shout: async (input) => input }, opRunSinks: { log: { name: 'log', write: async (v) => v } } }
    const res = await handler.fetch(new Request('https://fileops.example/op/schema'), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { leaves: Record<string, unknown>; sinks: string[] }
    expect(Object.keys(body.leaves)).toContain('shout')
    expect(body.sinks).toContain('log')
  })

  it('POST /op/validate: a well-formed spec reports valid with no errors, without running it', async () => {
    const res = await post('op/validate', { spec: { tag: 'leaf', name: 'convert', params: { from: 'json', to: 'yaml' } } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: true, errors: [] })
  })

  it('POST /op/validate: collects every structural error in one pass instead of stopping at the first (#208)', async () => {
    const res = await post('op/validate', {
      spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'nope' }, { tag: 'map', op: { tag: 'leaf', name: 'scrub' }, concurrency: 0 }] },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { valid: boolean; errors: Array<{ path: string; message: string }> }
    expect(body.valid).toBe(false)
    expect(body.errors.some((e) => /unknown leaf "nope"/.test(e.message))).toBe(true)
    expect(body.errors.some((e) => /concurrency/.test(e.message))).toBe(true)
  })

  it('POST /op/validate: a missing `spec` surfaces a 400', async () => {
    const res = await post('op/validate', {})
    expect(res.status).toBe(400)
  })

  it('POST /op/validate: env.opRunLeaves lets a host-registered leaf validate as known', async () => {
    const env: Env = { opRunLeaves: { shout: async (input) => input } }
    const res = await post('op/validate', { spec: { tag: 'leaf', name: 'shout' } }, {}, env)
    expect(await res.json()).toEqual({ valid: true, errors: [] })
  })

  it('POST /op/plan: reports a non-executing cost/capability audit (#361)', async () => {
    const res = await post('op/plan', {
      spec: { tag: 'pipe', steps: [{ tag: 'leaf', name: 'summarize', opts: { retries: 1 } }, { tag: 'sink', targets: ['store'] }] },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nodeCount: number; maxRetryMultiplier: number; usesLlm: boolean; llmLeaves: string[]; sinkTargets: string[] }
    expect(body.nodeCount).toBe(3)
    expect(body.maxRetryMultiplier).toBe(2 + 1) // summarize retries:1 -> 2, sink default -> 1
    expect(body.usesLlm).toBe(true)
    expect(body.llmLeaves).toEqual(['summarize'])
    expect(body.sinkTargets).toEqual(['store'])
  })

  it('POST /op/plan: a missing `spec` surfaces a 400', async () => {
    const res = await post('op/plan', {})
    expect(res.status).toBe(400)
  })
})
