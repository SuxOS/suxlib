// OpenTelemetry exporter adapter (#334): translates the op engine's
// onTrace/onEvent hooks (src/control/trace.ts, src/control/events.ts) into
// OTLP/HTTP JSON spans, so a host can point a run at a real OTel collector
// with zero changes to runInline/runGoverned. Dependency-light like the rest
// of this repo -- OTLP/HTTP is just JSON over fetch, no OTel SDK needed.
//
// Span tree: a TraceEvent's `path` is already a genuine hierarchical route
// (childPath() in src/runtime/inline.ts always builds a child's path as
// `parentPath + "/" + segment"), so a span's parent is just whatever span is
// still open at `path.slice(0, path.lastIndexOf('/'))` *within the same
// run* -- `path` alone repeats across separate runInline calls (every call's
// own root is `path === ''`), so lookups are scoped by the TraceEvent's
// `runId` (#346) first, then `path` within that run's own map. `traceId` is
// derived directly from `runId` (a v4 UUID's 32 hex digits with the dashes
// stripped are already a spec-valid 16-byte OTel trace id) rather than
// minted per root `path` -- so two concurrent runs sharing this exporter
// always land in distinct, correctly-attributed traces even when their
// windows overlap without nesting and they visit the exact same relative
// path. `durationMs` is already computed by `traced()`, so span timing needs
// no extra instrumentation -- the exporter just anchors each span's start at
// the real wall-clock time its node-enter arrived (not caps.clock, which
// tests often fake) and adds durationMs on top for the end.
//
// GovernorEvents are keyed by leaf `name` first (#334's original scoping),
// disambiguated by `runId` (#348) and, since #380, by `callId` too:
// `openByName` tracks entries (each already carrying the `callId` its
// TraceEvent node-enter minted, #366) per name, and `onEvent` prefers an
// exact `callId` match, then the innermost still-open entry whose `runId`
// matches, only falling back to "the innermost span sharing this name" (the
// old, run-blind behavior) when the event carries neither -- a primitive
// driven outside `runGoverned`/`runInline`. `runGoverned` (src/control/
// governor.ts) threads the calling runInline call's `runId` *and* the exact
// node's `callId` into every governor primitive's gating method
// (allow/onSuccess/onFailure/take/release), and each primitive stamps both
// onto the GovernorEvent it emits. `callId` is what actually disambiguates
// two duplicate-named leaves/sink-targets *within one run* (e.g.
// sink.fanout(['a', 'a'])) sharing one `runId` -- `runId` alone can't tell
// those apart, which #380 exists to close.
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
  const { kind: _kind, name: _name, runId: _runId, callId: _callId, ...rest } = e as GovernorEvent & { name?: string; runId?: string; callId?: string }
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
 * every adapter today via `opRunGOpts` with zero further plumbing. Each
 * TraceEvent's `runId` (#346) maps directly to its span's `traceId`, so
 * spans across separate calls sharing one exporter instance always land in
 * distinct, correctly-attributed traces -- including two calls whose
 * windows overlap without nesting.
 */
export function createOtelExporter(opts: OtelExporterOpts): OtelExporter {
  const fetchFn = opts.fetchFn ?? fetch
  const maxBuffered = opts.maxBufferedSpans ?? DEFAULT_MAX_BUFFERED_SPANS
  const serviceName = opts.serviceName ?? 'suxlib-op-engine'

  // Keyed by runId first, then path -- but each path's value is still a
  // *stack* (not a single entry): within one run, the same relative path can
  // legitimately be open more than once at a time (e.g. sink.fanout(['a',
  // 'a']) reaches childPath(path, 'a') twice concurrently), so a flat
  // Map<path, entry> per run would let the second push silently clobber the
  // first's still-open entry. Scoping the outer map by runId (#346) is what
  // actually fixes cross-run clobbering -- two concurrent runInline calls
  // sharing this exporter instance never share a path-map, even when their
  // windows overlap without nesting and they visit the exact same relative
  // path.
  // events lives directly on each OpenEntry (pushed in onEvent by finding
  // the matching stack entry, not a separate path-keyed map) so that two
  // duplicate-named concurrent spans (e.g. sink.fanout(['a', 'a'])) each
  // keep their own event list through to node-exit -- a map keyed only by
  // `${runId}::${path}` would merge both spans' events into one list and
  // hand the whole thing to whichever span's node-exit fired first.
  type OpenEntry = {
    spanId: string
    startNano: bigint
    tag: string
    name?: string
    callId: string
    runId: string
    events: { name: string; timeUnixNano: string; attributes: Record<string, AttrValue> }[]
  }
  const open = new Map<string, Map<string, OpenEntry[]>>()
  // Keyed by leaf name to a stack of the *same* OpenEntry objects held in
  // `open`'s per-path stacks (shared references, not copies) -- runId (#348)
  // lets onEvent below prefer the span that's actually in the same run as
  // the GovernorEvent it's attaching, instead of always falling back to "the
  // innermost span sharing this leaf name" regardless of which run opened
  // it. A GovernorEvent with no runId (a primitive shared outside runInline,
  // or an older caller) still falls back to that old best-effort behavior.
  const openByName = new Map<string, OpenEntry[]>()
  const finished: OtelSpan[] = []

  function pushFinished(span: OtelSpan): void {
    finished.push(span)
    while (finished.length > maxBuffered) finished.shift()
  }

  function peekOpen(pathMap: Map<string, OpenEntry[]>, path: string) {
    const stack = pathMap.get(path)
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined
  }

  // A v4 UUID (crypto.randomUUID(), what runInline mints runId from) is 32
  // hex digits once the dashes are stripped -- already a spec-valid 16-byte
  // OTel trace id, so no separate random mint is needed here.
  const traceIdOf = (runId: string): string => runId.replace(/-/g, '')

  const onTrace: TraceEventHandler = (e: TraceEvent) => {
    if (e.kind === 'node-enter') {
      const pathMap = open.get(e.runId) ?? new Map<string, OpenEntry[]>()
      open.set(e.runId, pathMap)
      const stack = pathMap.get(e.path) ?? []
      const entry: OpenEntry = { spanId: randomHex(8), startNano: BigInt(Date.now()) * 1_000_000n, tag: e.tag, name: e.name, callId: e.callId, runId: e.runId, events: [] }
      stack.push(entry)
      pathMap.set(e.path, stack)
      if (e.name) {
        const nameStack = openByName.get(e.name) ?? []
        nameStack.push(entry)
        openByName.set(e.name, nameStack)
      }
      return
    }
    // node-exit -- find and remove the specific entry this call's node-enter
    // pushed (matched by callId), not just whatever's topmost. Two
    // concurrent calls sharing this exact path (e.g. sink.fanout(['a',
    // 'a'])) can exit in either order, and popping topmost unconditionally
    // would attribute this exit's durationMs/ok/error to whichever entry
    // happens to still be on top, regardless of which one actually finished.
    const pathMap = open.get(e.runId)
    const stack = pathMap?.get(e.path)
    const idx = stack?.findIndex((entry) => entry.callId === e.callId) ?? -1
    const entry = idx === -1 || !stack ? undefined : stack.splice(idx, 1)[0]
    if (!pathMap || !entry) return // defensive: an exit with no matching enter should not happen
    if (stack && stack.length === 0) pathMap.delete(e.path)
    if (e.name) {
      const nameStack = openByName.get(e.name)
      if (nameStack) {
        const i = nameStack.findIndex((x) => x.callId === e.callId)
        if (i !== -1) nameStack.splice(i, 1)
        if (nameStack.length === 0) openByName.delete(e.name)
      }
    }
    const pPath = parentPathOf(e.path)
    const parentSpanId = pPath === undefined ? undefined : peekOpen(pathMap, pPath)?.spanId
    if (pathMap.size === 0) open.delete(e.runId)
    const endNano = entry.startNano + BigInt(Math.round(e.durationMs * 1_000_000))
    pushFinished({
      traceId: traceIdOf(e.runId),
      spanId: entry.spanId,
      parentSpanId,
      name: e.name ? `${e.tag}:${e.name}` : e.tag,
      startTimeUnixNano: entry.startNano.toString(),
      endTimeUnixNano: endNano.toString(),
      attributes: { 'op.tag': e.tag, ...(e.name ? { 'op.name': e.name } : {}), 'op.path': e.path },
      events: entry.events,
      status: e.ok ? { code: 'OK' } : { code: 'ERROR', message: e.error },
    })
  }

  const onEvent: GovernorEventHandler = (e: GovernorEvent) => {
    const name = 'name' in e ? e.name : undefined
    if (!name) return
    const stack = openByName.get(name)
    if (!stack || stack.length === 0) return
    // Prefer an exact callId match (#380) -- the only way to tell apart two
    // duplicate-named spans that also share one runId (e.g.
    // sink.fanout(['a', 'a'])). Fall back to "the innermost open span also in
    // the same run" (#348) when the event carries no callId (an older
    // primitive call, or one driven outside runGoverned), and further to
    // "the innermost span sharing this leaf name" when it carries no runId
    // either (a primitive driven outside runInline entirely).
    const callId = 'callId' in e ? e.callId : undefined
    const runId = 'runId' in e ? e.runId : undefined
    const byCallId = callId ? [...stack].reverse().find(s => s.callId === callId) : undefined
    const byRunId = runId ? [...stack].reverse().find(s => s.runId === runId) : undefined
    const entry = byCallId ?? byRunId ?? stack[stack.length - 1]
    entry.events.push({ name: e.kind, timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(), attributes: eventAttributes(e) })
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
