import { describe, expect, it, vi } from 'vitest'
import { createOtelExporter } from '../../src/adapters/otel.js'
import { op, pipe } from '../../src/op/combinators.js'
import { runInline } from '../../src/runtime/inline.js'
import { createGovernor } from '../../src/control/governor.js'

function clockCaps(governors?: Record<string, any>) {
  let now = 0
  return { store: {}, llm: {}, clock: { now: () => now++ }, sinks: {}, governors } as any
}

describe('otel exporter', () => {
  it('emits one OK span for a single leaf, with no parent', async () => {
    const exporter = createOtelExporter({ endpoint: 'https://collector.example/v1/traces' })
    const leaf = op('id', async (n: number) => n + 1, { kind: 'pure' })
    const result = await runInline(leaf, 1, clockCaps(), { onTrace: exporter.onTrace })
    expect(result).toBe(2)
    expect(exporter.pendingCount()).toBe(1)
  })

  it('flush() is a no-op with nothing buffered', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    await createOtelExporter({ endpoint: 'https://x', fetchFn }).flush()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('builds a parent/child span tree matching a pipe\'s step nesting', async () => {
    const tree = pipe(
      op('a', async (n: number) => n + 1, { kind: 'pure' }),
      op('b', async (n: number) => n * 2, { kind: 'pure' }),
    )
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const body = JSON.parse(req.body)
      const spans = body.resourceSpans[0].scopeSpans[0].spans
      expect(spans).toHaveLength(3)
      const pipeSpan = spans.find((s: any) => s.name === 'pipe')
      const aSpan = spans.find((s: any) => s.name === 'leaf:a')
      const bSpan = spans.find((s: any) => s.name === 'leaf:b')
      expect(pipeSpan.parentSpanId).toBeUndefined()
      expect(aSpan.parentSpanId).toBe(pipeSpan.spanId)
      expect(bSpan.parentSpanId).toBe(pipeSpan.spanId)
      expect(aSpan.traceId).toBe(pipeSpan.traceId)
      expect(spans.every((s: any) => s.status.code === 1)).toBe(true)
      return new Response(null, { status: 200 })
    })
    const flushExporter = createOtelExporter({ endpoint: 'https://collector.example/v1/traces', fetchFn })
    const result = await runInline(tree, 1, clockCaps(), { onTrace: flushExporter.onTrace })
    expect(result).toBe(4)
    await flushExporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(flushExporter.pendingCount()).toBe(0)
  })

  it('marks a failing leaf span ERROR with the thrown message', async () => {
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const body = JSON.parse(req.body)
      const span = body.resourceSpans[0].scopeSpans[0].spans[0]
      expect(span.status).toEqual({ code: 2, message: 'kaboom' })
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    const leaf = op('boom', async () => { throw new Error('kaboom') }, { kind: 'pure' })
    await expect(runInline(leaf, null, clockCaps(), { onTrace: exporter.onTrace })).rejects.toThrow('kaboom')
    await exporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('attaches a GovernorEvent to the innermost open span sharing its leaf name', async () => {
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const body = JSON.parse(req.body)
      const span = body.resourceSpans[0].scopeSpans[0].spans[0]
      expect(span.events.some((e: any) => e.name === 'retry-attempt')).toBe(true)
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    const governor = createGovernor('flaky', {}, exporter.onEvent)
    let calls = 0
    const leaf = op('flaky', async () => { calls++; if (calls === 1) throw new Error('first try fails'); return 'ok' }, { kind: 'effect', retries: 1 })
    const caps = clockCaps({ flaky: governor })
    const result = await runInline(leaf, null, caps, { onTrace: exporter.onTrace, onEvent: exporter.onEvent, backoff: { base: 0, cap: 0 }, sleep: async () => {} })
    expect(result).toBe('ok')
    await exporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('gives each of two overlapping runInline calls its own traceId, not a shared/overwritten one', async () => {
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const body = JSON.parse(req.body)
      const spans = body.resourceSpans[0].scopeSpans[0].spans
      expect(spans).toHaveLength(2)
      const slowSpan = spans.find((s: any) => s.name === 'leaf:slow')
      const fastSpan = spans.find((s: any) => s.name === 'leaf:fast')
      expect(slowSpan.traceId).not.toBe(fastSpan.traceId)
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    const slow = op('slow', async (n: number) => { await new Promise((r) => setTimeout(r, 30)); return n }, { kind: 'pure' })
    const fast = op('fast', async (n: number) => { await new Promise((r) => setTimeout(r, 5)); return n }, { kind: 'pure' })
    await Promise.all([
      runInline(slow, 1, clockCaps(), { onTrace: exporter.onTrace }),
      runInline(fast, 2, clockCaps(), { onTrace: exporter.onTrace }),
    ])
    await exporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('drops the oldest buffered span once maxBufferedSpans is exceeded', async () => {
    const exporter = createOtelExporter({ endpoint: 'https://x', maxBufferedSpans: 2 })
    for (let i = 0; i < 5; i++) {
      const leaf = op(`n${i}`, async (n: number) => n, { kind: 'pure' })
      await runInline(leaf, i, clockCaps(), { onTrace: exporter.onTrace })
    }
    expect(exporter.pendingCount()).toBe(2)
  })

  it('re-buffers the batch (bounded) for a later retry when flush fails', async () => {
    let attempt = 0
    const fetchFn = vi.fn(async () => {
      attempt++
      return attempt === 1 ? new Response('boom', { status: 500 }) : new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    const leaf = op('id', async (n: number) => n, { kind: 'pure' })
    await runInline(leaf, 1, clockCaps(), { onTrace: exporter.onTrace })
    await expect(exporter.flush()).rejects.toThrow(/flush failed/)
    expect(exporter.pendingCount()).toBe(1)
    await exporter.flush()
    expect(exporter.pendingCount()).toBe(0)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
