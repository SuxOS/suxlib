// OpenTelemetry exporter adapter (#334): translates the op engine's
// onTrace/onEvent hooks (src/control/trace.ts, src/control/events.ts) into
// OTLP/HTTP JSON spans, so a host can point a run at a real OTel collector
// with zero changes to runInline/runGoverned. Dependency-light like the rest
// of this repo -- OTLP/HTTP is just JSON over fetch, no OTel SDK needed.
//
// Span tree: a TraceEvent's `path` is already a genuine hierarchical route
// (childPath() in src/runtime/inline.ts always builds a child's path as
// `parentPath + "/" + segment"), so a span's parent is just whatever span is
// still open at `path.slice(0, path.lastIndexOf('/'))`. `durationMs` is
// already computed by `traced()`, so span timing needs no extra
// instrumentation -- the exporter just anchors each span's start at the
// real wall-clock time its node-enter arrived (not caps.clock, which tests
// often fake) and adds durationMs on top for the end.
//
// GovernorEvents are keyed by leaf `name`, not `path` -- the same leaf name
// can be open at more than one path at once (concurrent map/mapField
// items), so there's no exact way to attach an event to "the" span that
// caused it. This attaches to the innermost (most recently entered, still
// open) span sharing that name -- a best-effort approximation, not a precise
// correlation; see #334's own scoping note.
//
// onTrace/onEvent must never throw: src/runtime/inline.ts's traced() calls
// onTrace directly inside its try, so a throw from here on the success path
// would be indistinguishable from the node itself failing (the same #275
// class of bug governor.ts's post-success bookkeeping guards against). So
// the span buffer is a bounded ring (drop-oldest) rather than a bomb guard
// that throws.

import type { TraceEvent, TraceEventHandler } from '../control/trace.js'
import type { GovernorEvent, GovernorEventHandler } from '../control/events.js'

type AttrValue = string | number | boolean

export interface OtelSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, AttrValue>
  events: { name: string; timeUnixNano: string; attributes: Record<string, AttrValue> }[]
  status: { code: 'OK' | 'ERROR'; message?: string }
}

export interface OtelExporterOpts {
  endpoint: string
  serviceName?: string
  headers?: Record<string, string>
  fetchFn?: typeof fetch
  // Ring-buffer cap on finished-but-not-yet-flushed spans -- a host that
  // never calls flush() (or whose collector is down) drops the oldest span
  // rather than growing this process's memory without bound.
  maxBufferedSpans?: number
}

export interface OtelExporter {
  onTrace: TraceEventHandler
  onEvent: GovernorEventHandler
  flush(): Promise<void>
  pendingCount(): number
}

const DEFAULT_MAX_BUFFERED_SPANS = 2_000

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function parentPathOf(path: string): string | undefined {
  if (path === '') return undefined
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function attrValue(v: AttrValue): { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
}

function attrList(attrs: Record<string, AttrValue>): { key: string; value: ReturnType<typeof attrValue> }[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: attrValue(value) }))
}

function eventAttributes(e: GovernorEvent): Record<string, AttrValue> {
  const { kind: _kind, name: _name, ...rest } = e as GovernorEvent & { name?: string }
  return rest as Record<string, AttrValue>
}

function toOtlpSpan(s: OtelSpan): Record<string, unknown> {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano,
    attributes: attrList(s.attributes),
    events: s.events.map((e) => ({ timeUnixNano: e.timeUnixNano, name: e.name, attributes: attrList(e.attributes) })),
    status: { code: s.status.code === 'OK' ? 1 : 2, ...(s.status.message ? { message: s.status.message } : {}) },
  }
}

/**
 * Builds one exporter instance's `onTrace`/`onEvent` pair, meant to be passed
 * as `RunGovernedOpts.onTrace`/`onEvent` (src/control/governor.ts) -- reaches
 * every adapter today via `opRunGOpts` with zero further plumbing. A fresh
 * traceId is minted whenever a node-enter arrives at `path === ''` (the root
 * of a runInline call), so spans across separate calls sharing one exporter
 * instance still land in distinct traces.
 */
export function createOtelExporter(opts: OtelExporterOpts): OtelExporter {
  const fetchFn = opts.fetchFn ?? fetch
  const maxBuffered = opts.maxBufferedSpans ?? DEFAULT_MAX_BUFFERED_SPANS
  const serviceName = opts.serviceName ?? 'suxlib-op-engine'

  // Keyed by path, but each value is a *stack* (not a single entry): a path
  // string is only unique within one runInline call (it's rebuilt from '' at
  // every call's own root), so two overlapping runInline calls sharing this
  // exporter instance both produce a node-enter at path '' -- a flat
  // Map<path, entry> would let the second one's set() silently clobber the
  // first's still-open entry. Pushing/popping preserves both; traceId is
  // minted fresh per root entry and inherited by children via the parent's
  // still-open entry (same lookup parentSpanId already does), not a shared
  // mutable variable, so a finished span is always stamped with its own
  // run's traceId even while another run is mid-flight on the same exporter.
  const open = new Map<string, { spanId: string; startNano: bigint; tag: string; name?: string; traceId: string }[]>()
  const openByName = new Map<string, string[]>()
  const pendingEvents = new Map<string, { name: string; timeUnixNano: string; attributes: Record<string, AttrValue> }[]>()
  const finished: OtelSpan[] = []

  function pushFinished(span: OtelSpan): void {
    finished.push(span)
    while (finished.length > maxBuffered) finished.shift()
  }

  function peekOpen(path: string) {
    const stack = open.get(path)
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined
  }

  const onTrace: TraceEventHandler = (e: TraceEvent) => {
    if (e.kind === 'node-enter') {
      const pPath = parentPathOf(e.path)
      const parentEntry = pPath === undefined ? undefined : peekOpen(pPath)
      const traceId = e.path === '' ? randomHex(16) : (parentEntry?.traceId ?? randomHex(16))
      const stack = open.get(e.path) ?? []
      stack.push({ spanId: randomHex(8), startNano: BigInt(Date.now()) * 1_000_000n, tag: e.tag, name: e.name, traceId })
      open.set(e.path, stack)
      if (e.name) {
        const nameStack = openByName.get(e.name) ?? []
        nameStack.push(e.path)
        openByName.set(e.name, nameStack)
      }
      return
    }
    // node-exit
    const stack = open.get(e.path)
    const entry = stack?.pop()
    if (!entry) return // defensive: an exit with no matching enter should not happen
    if (stack && stack.length === 0) open.delete(e.path)
    if (e.name) {
      const nameStack = openByName.get(e.name)
      if (nameStack) {
        const i = nameStack.lastIndexOf(e.path)
        if (i !== -1) nameStack.splice(i, 1)
        if (nameStack.length === 0) openByName.delete(e.name)
      }
    }
    const pPath = parentPathOf(e.path)
    const parentSpanId = pPath === undefined ? undefined : peekOpen(pPath)?.spanId
    const endNano = entry.startNano + BigInt(Math.round(e.durationMs * 1_000_000))
    const events = pendingEvents.get(e.path) ?? []
    pendingEvents.delete(e.path)
    pushFinished({
      traceId: entry.traceId,
      spanId: entry.spanId,
      parentSpanId,
      name: e.name ? `${e.tag}:${e.name}` : e.tag,
      startTimeUnixNano: entry.startNano.toString(),
      endTimeUnixNano: endNano.toString(),
      attributes: { 'op.tag': e.tag, ...(e.name ? { 'op.name': e.name } : {}), 'op.path': e.path },
      events,
      status: e.ok ? { code: 'OK' } : { code: 'ERROR', message: e.error },
    })
  }

  const onEvent: GovernorEventHandler = (e: GovernorEvent) => {
    const name = 'name' in e ? e.name : undefined
    if (!name) return
    const stack = openByName.get(name)
    if (!stack || stack.length === 0) return
    const path = stack[stack.length - 1]
    const list = pendingEvents.get(path) ?? []
    list.push({ name: e.kind, timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(), attributes: eventAttributes(e) })
    pendingEvents.set(path, list)
  }

  async function flush(): Promise<void> {
    if (finished.length === 0) return
    const batch = finished.splice(0, finished.length)
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{ scope: { name: 'suxlib-op-engine' }, spans: batch.map(toOtlpSpan) }],
        },
      ],
    }
    let res: Response
    try {
      res = await fetchFn(opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(body),
      })
    } catch (err) {
      finished.unshift(...batch)
      while (finished.length > maxBuffered) finished.shift()
      throw err
    }
    if (!res.ok) {
      finished.unshift(...batch)
      while (finished.length > maxBuffered) finished.shift()
      throw new Error(`otel exporter flush failed: ${res.status} ${res.statusText}`)
    }
  }

  return { onTrace, onEvent, flush, pendingCount: () => finished.length }
}

export interface OtelMetricsExporterOpts {
  endpoint: string
  serviceName?: string
  headers?: Record<string, string>
  fetchFn?: typeof fetch
  // Explicit histogram bucket boundaries (ms) for the node-duration
  // histogram built from onTrace's node-exit durationMs.
  histogramBoundsMs?: number[]
}

export interface OtelMetricsExporter {
  onTrace: TraceEventHandler
  onEvent: GovernorEventHandler
  flush(): Promise<void>
}

const DEFAULT_HISTOGRAM_BOUNDS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

/**
 * Builds one exporter instance's `onTrace`/`onEvent` pair, aggregating the
 * Governor event stream (`GovernorEvent`, src/control/events.ts) and node
 * durations (`TraceEvent`, src/control/trace.ts) into OTLP metric data
 * points -- the counterpart to `createOtelExporter`'s spans, following #334's
 * same dependency-light OTLP/HTTP-JSON-over-fetch approach.
 *
 * Unlike the span exporter, this one holds cumulative aggregated state (a
 * handful of counters/gauges/histograms keyed by leaf name, not a growing
 * list of finished items), so `flush()` just POSTs the current totals with
 * OTLP's CUMULATIVE aggregation temporality -- there's nothing to drop or
 * re-buffer on a failed flush, since the next successful flush resends the
 * (by-then-larger) running totals rather than losing anything.
 */
export function createOtelMetricsExporter(opts: OtelMetricsExporterOpts): OtelMetricsExporter {
  const fetchFn = opts.fetchFn ?? fetch
  const serviceName = opts.serviceName ?? 'suxlib-op-engine'
  const bounds = opts.histogramBoundsMs ?? DEFAULT_HISTOGRAM_BOUNDS_MS
  const startTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString()

  // Nested by metric/tag first, then by leaf name (empty string standing in
  // for "no name") -- deliberately not a single joined string key, since a
  // leaf name is caller-chosen and could contain whatever separator a joined
  // key might pick.
  const counters = new Map<string, Map<string, number>>()
  const gauges = new Map<string, number>()
  const histograms = new Map<string, Map<string, { count: number; sum: number; bucketCounts: number[] }>>()

  function bumpCounter(metric: string, name: string | undefined): void {
    const byName = counters.get(metric) ?? new Map<string, number>()
    const key = name ?? ''
    byName.set(key, (byName.get(key) ?? 0) + 1)
    counters.set(metric, byName)
  }

  function setGauge(name: string | undefined, value: number): void {
    gauges.set(name ?? '', value)
  }

  function recordHistogram(tag: string, name: string | undefined, durationMs: number): void {
    const byName = histograms.get(tag) ?? new Map<string, { count: number; sum: number; bucketCounts: number[] }>()
    const key = name ?? ''
    const h = byName.get(key) ?? { count: 0, sum: 0, bucketCounts: new Array(bounds.length + 1).fill(0) }
    h.count++
    h.sum += durationMs
    const idx = bounds.findIndex((b) => durationMs <= b)
    h.bucketCounts[idx === -1 ? bounds.length : idx]++
    byName.set(key, h)
    histograms.set(tag, byName)
  }

  const onTrace: TraceEventHandler = (e: TraceEvent) => {
    if (e.kind !== 'node-exit') return
    recordHistogram(e.tag, e.name, e.durationMs)
  }

  const onEvent: GovernorEventHandler = (e: GovernorEvent) => {
    const name = 'name' in e ? e.name : undefined
    switch (e.kind) {
      case 'breaker-open': return bumpCounter('op.breaker_open_total', name)
      case 'breaker-half-open': return bumpCounter('op.breaker_half_open_total', name)
      case 'breaker-close': return bumpCounter('op.breaker_close_total', name)
      case 'aimd-increase': setGauge(name, e.limit); return bumpCounter('op.aimd_increase_total', name)
      case 'aimd-decrease': setGauge(name, e.limit); return bumpCounter('op.aimd_decrease_total', name)
      case 'token-wait': return bumpCounter('op.token_wait_total', name)
      case 'retry-attempt': return bumpCounter('op.retry_attempts_total', name)
      case 'memo-hit': return bumpCounter('op.memo_hit_total', name)
      case 'memo-miss': return bumpCounter('op.memo_miss_total', name)
    }
  }

  function toOtlpMetrics(): Record<string, unknown>[] {
    const nowNano = (BigInt(Date.now()) * 1_000_000n).toString()
    const metrics: Record<string, unknown>[] = []
    for (const [metric, byName] of counters) {
      metrics.push({
        name: metric,
        sum: {
          dataPoints: [...byName].map(([name, value]) => ({
            attributes: name ? attrList({ 'op.name': name }) : [],
            startTimeUnixNano,
            timeUnixNano: nowNano,
            asInt: String(value),
          })),
          aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
          isMonotonic: true,
        },
      })
    }
    if (gauges.size > 0) {
      metrics.push({
        name: 'op.aimd_limit',
        gauge: {
          dataPoints: [...gauges].map(([name, value]) => ({
            attributes: name ? attrList({ 'op.name': name }) : [],
            timeUnixNano: nowNano,
            asDouble: value,
          })),
        },
      })
    }
    for (const [tag, byName] of histograms) {
      for (const [name, h] of byName) {
        metrics.push({
          name: 'op.node_duration_ms',
          histogram: {
            dataPoints: [
              {
                attributes: attrList({ 'op.tag': tag, ...(name ? { 'op.name': name } : {}) }),
                startTimeUnixNano,
                timeUnixNano: nowNano,
                count: String(h.count),
                sum: h.sum,
                bucketCounts: h.bucketCounts.map(String),
                explicitBounds: bounds,
              },
            ],
            aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
          },
        })
      }
    }
    return metrics
  }

  async function flush(): Promise<void> {
    const metrics = toOtlpMetrics()
    if (metrics.length === 0) return
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeMetrics: [{ scope: { name: 'suxlib-op-engine' }, metrics }],
        },
      ],
    }
    const res = await fetchFn(opts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`otel metrics exporter flush failed: ${res.status} ${res.statusText}`)
  }

  return { onTrace, onEvent, flush }
}
