import { describe, expect, it, vi } from 'vitest'
import { createOtelExporter, createOtelMetricsExporter } from '../../src/adapters/otel.js'
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

  it('scopes a GovernorEvent to the run that produced it, not just the innermost span sharing its leaf name (#348)', async () => {
    const traceIdOf = (runId: string) => runId.replace(/-/g, '')
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const spans = JSON.parse(req.body).resourceSpans[0].scopeSpans[0].spans
      const spanA = spans.find((s: any) => s.traceId === traceIdOf('run-A'))
      const spanB = spans.find((s: any) => s.traceId === traceIdOf('run-B'))
      expect(spanA.events.some((e: any) => e.name === 'retry-attempt')).toBe(true)
      expect(spanB.events.some((e: any) => e.name === 'retry-attempt')).toBe(false)
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    // Two concurrent "flaky" spans, same leaf name, distinct runs -- run-B's
    // span is entered second, so it's "the innermost span sharing this leaf
    // name" by the pre-#348 name-only fallback. A retry-attempt tagged with
    // run-A's own runId must still land on run-A's span, not run-B's, even
    // though run-B's span is the one still open more recently.
    exporter.onTrace({ kind: 'node-enter', tag: 'leaf', name: 'flaky', path: '', runId: 'run-A', callId: 'call-A' })
    exporter.onTrace({ kind: 'node-enter', tag: 'leaf', name: 'flaky', path: '', runId: 'run-B', callId: 'call-B' })
    exporter.onEvent({ kind: 'retry-attempt', name: 'flaky', attempt: 0, delayMs: 5, runId: 'run-A' })
    exporter.onTrace({ kind: 'node-exit', tag: 'leaf', name: 'flaky', path: '', runId: 'run-A', callId: 'call-A', durationMs: 1, ok: true })
    exporter.onTrace({ kind: 'node-exit', tag: 'leaf', name: 'flaky', path: '', runId: 'run-B', callId: 'call-B', durationMs: 1, ok: true })
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

  it('does not misattribute spans/parentage between two concurrent runs of the identical op-tree shape whose windows overlap without nesting (#346)', async () => {
    let spans: any[] = []
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      spans = JSON.parse(req.body).resourceSpans[0].scopeSpans[0].spans
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    const treeFor = (delayMs: number) => pipe(
      op('a', async (n: number) => { await new Promise((r) => setTimeout(r, delayMs)); return n + 1 }, { kind: 'pure' }),
      op('b', async (n: number) => n * 2, { kind: 'pure' }),
    )
    await Promise.all([
      runInline(treeFor(15), 1, clockCaps(), { onTrace: exporter.onTrace }),
      runInline(treeFor(5), 10, clockCaps(), { onTrace: exporter.onTrace }),
    ])
    await exporter.flush()
    expect(spans).toHaveLength(6)
    const pipes = spans.filter((s: any) => s.name === 'pipe')
    expect(pipes).toHaveLength(2)
    expect(pipes[0].traceId).not.toBe(pipes[1].traceId)
    for (const pipeSpan of pipes) {
      const children = spans.filter((s: any) => s.parentSpanId === pipeSpan.spanId)
      expect(children).toHaveLength(2)
      // Every child of this pipe span must share its own run's traceId, not
      // the other concurrent run's -- the exact misattribution #346 flags.
      expect(children.every((c: any) => c.traceId === pipeSpan.traceId)).toBe(true)
    }
  })

  it('attributes each duplicate-named concurrent span\'s own timing/status by callId, not by exit order (#366)', async () => {
    const exporter = createOtelExporter({ endpoint: 'https://x' })
    // Two spans open at the identical path/runId/name (e.g. sink.fanout(['a',
    // 'a'])): entry1 pushed first, entry2 pushed second. The *second* real
    // call (callId '2') is the one that exits FIRST here -- if the exporter
    // blindly popped topmost-of-stack, it would wrongly attribute callId-2's
    // exit data to entry1 and vice versa.
    exporter.onTrace({ kind: 'node-enter', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '1' })
    exporter.onTrace({ kind: 'node-enter', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '2' })
    exporter.onTrace({ kind: 'node-exit', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '2', durationMs: 1, ok: true })
    exporter.onTrace({ kind: 'node-exit', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '1', durationMs: 999, ok: false, error: 'target0-failed' })
    expect(exporter.pendingCount()).toBe(2)
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const spans = JSON.parse(req.body).resourceSpans[0].scopeSpans[0].spans
      expect(spans).toHaveLength(2)
      const okSpan = spans.find((s: any) => s.status.code === 1)
      const errSpan = spans.find((s: any) => s.status.code === 2)
      expect(okSpan.endTimeUnixNano).not.toBe(errSpan.endTimeUnixNano)
      expect(errSpan.status.message).toBe('target0-failed')
      return new Response(null, { status: 200 })
    })
    const flushExporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    flushExporter.onTrace({ kind: 'node-enter', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '1' })
    flushExporter.onTrace({ kind: 'node-enter', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '2' })
    flushExporter.onTrace({ kind: 'node-exit', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '2', durationMs: 1, ok: true })
    flushExporter.onTrace({ kind: 'node-exit', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '1', durationMs: 999, ok: false, error: 'target0-failed' })
    await flushExporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('keeps each duplicate-named concurrent span\'s own GovernorEvent list, not a merged/misattributed one (#357)', async () => {
    let spans: any[] = []
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      spans = JSON.parse(req.body).resourceSpans[0].scopeSpans[0].spans
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelExporter({ endpoint: 'https://x', fetchFn })
    // Two spans open at the identical path/runId/name (e.g.
    // sink.fanout(['a', 'a'])): entry1 (callId '1') pushed first, entry2
    // (callId '2') pushed second -- so entry2 is "the innermost span sharing
    // this name" that a name-only GovernorEvent (no runId) attaches to.
    exporter.onTrace({ kind: 'node-enter', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '1' })
    exporter.onTrace({ kind: 'node-enter', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '2' })
    exporter.onEvent({ kind: 'retry-attempt', name: 'a', attempt: 0, delayMs: 5 })
    // callId '1' -- NOT the entry onEvent above attaches to -- exits FIRST
    // here. A path-keyed pendingEvents map (the pre-#357 bug) hands whichever
    // span exits first every event pending for this shared path, regardless
    // of which entry onEvent actually meant to attach it to -- so callId '1'
    // would wrongly steal callId '2''s event the moment it pops the shared
    // list, leaving callId '2' with none.
    exporter.onTrace({ kind: 'node-exit', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '1', durationMs: 1, ok: true })
    exporter.onTrace({ kind: 'node-exit', tag: 'sink-target', name: 'a', path: '0', runId: 'run-1', callId: '2', durationMs: 1, ok: true })
    await exporter.flush()
    expect(spans).toHaveLength(2)
    // pushFinished appends in node-exit order, so spans[0] is callId '1'
    // (exited first, wrongly favored by the pre-#357 path-keyed bug) and
    // spans[1] is callId '2' (the entry onEvent actually selected).
    expect(spans[0].events).toHaveLength(0)
    expect(spans[1].events).toHaveLength(1)
    expect(spans[1].events[0].name).toBe('retry-attempt')
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

describe('otel metrics exporter', () => {
  it('flush() is a no-op with nothing aggregated', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    await createOtelMetricsExporter({ endpoint: 'https://x', fetchFn }).flush()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('aggregates GovernorEvents into counters and a gauge, tagged by leaf name', async () => {
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const body = JSON.parse(req.body)
      const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics
      const retries = metrics.find((m: any) => m.name === 'op.retry_attempts_total')
      expect(retries.sum.dataPoints).toHaveLength(1)
      expect(retries.sum.dataPoints[0].asInt).toBe('2')
      expect(retries.sum.dataPoints[0].attributes).toEqual([{ key: 'op.name', value: { stringValue: 'flaky' } }])
      expect(retries.sum.aggregationTemporality).toBe(2)
      expect(retries.sum.isMonotonic).toBe(true)
      const breakerOpen = metrics.find((m: any) => m.name === 'op.breaker_open_total')
      expect(breakerOpen.sum.dataPoints[0].asInt).toBe('1')
      const gauge = metrics.find((m: any) => m.name === 'op.aimd_limit')
      expect(gauge.gauge.dataPoints[0].asDouble).toBe(4)
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelMetricsExporter({ endpoint: 'https://x', fetchFn })
    exporter.onEvent({ kind: 'retry-attempt', name: 'flaky', attempt: 1, delayMs: 0 })
    exporter.onEvent({ kind: 'retry-attempt', name: 'flaky', attempt: 2, delayMs: 0 })
    exporter.onEvent({ kind: 'breaker-open', name: 'flaky', nowMs: 0 })
    exporter.onEvent({ kind: 'aimd-increase', name: 'flaky', limit: 4 })
    await exporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('builds a node-duration histogram from onTrace node-exit events', async () => {
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      const body = JSON.parse(req.body)
      const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics
      const hist = metrics.find((m: any) => m.name === 'op.node_duration_ms')
      const point = hist.histogram.dataPoints[0]
      expect(point.count).toBe('2')
      expect(point.attributes).toEqual([{ key: 'op.tag', value: { stringValue: 'leaf' } }, { key: 'op.name', value: { stringValue: 'a' } }])
      expect(point.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0)).toBe(2)
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelMetricsExporter({ endpoint: 'https://x', fetchFn })
    const leaf = op('a', async (n: number) => n + 1, { kind: 'pure' })
    await runInline(leaf, 1, clockCaps(), { onTrace: exporter.onTrace })
    await runInline(leaf, 2, clockCaps(), { onTrace: exporter.onTrace })
    await exporter.flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('cumulative counters keep growing across flushes instead of resetting', async () => {
    const bodies: any[] = []
    const fetchFn = vi.fn(async (_url: any, req: any) => {
      bodies.push(JSON.parse(req.body))
      return new Response(null, { status: 200 })
    })
    const exporter = createOtelMetricsExporter({ endpoint: 'https://x', fetchFn })
    exporter.onEvent({ kind: 'memo-hit', name: 'cached' })
    await exporter.flush()
    exporter.onEvent({ kind: 'memo-hit', name: 'cached' })
    await exporter.flush()
    const firstCount = bodies[0].resourceMetrics[0].scopeMetrics[0].metrics.find((m: any) => m.name === 'op.memo_hit_total').sum.dataPoints[0].asInt
    const secondCount = bodies[1].resourceMetrics[0].scopeMetrics[0].metrics.find((m: any) => m.name === 'op.memo_hit_total').sum.dataPoints[0].asInt
    expect(firstCount).toBe('1')
    expect(secondCount).toBe('2')
  })

  it('rejects when the collector responds non-2xx', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }))
    const exporter = createOtelMetricsExporter({ endpoint: 'https://x', fetchFn })
    exporter.onEvent({ kind: 'memo-miss', name: 'cached' })
    await expect(exporter.flush()).rejects.toThrow(/flush failed/)
  })
})
