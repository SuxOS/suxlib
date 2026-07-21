// Shared plumbing for adapters that want to run a caller-supplied op-tree
// spec (src/op/spec.ts) against the leaf registry (src/op/registry.ts),
// rather than one domain function at a time. Used by http.ts's
// `POST /op/run` and mcp.ts's `run_pipeline` tool.
//
// A pipeline's intermediate values are real Handles (claim-checks into a
// Store), not bytes -- but an adapter request is JSON in, JSON out. So the
// caller marks any Handle it wants to seed as input with `{ $handle: true,
// base64, type? }`; hydrate() walks the input and turns those into real
// Handles in the run's Store (a fresh per-call MemoryStore by default, or a
// host-supplied persistent one -- see OpRunOpts below) before the run.
// dehydrate() does the reverse to the result, turning any Handle-shaped value
// it finds back into base64 -- the caller never sees or invents a Store key
// itself.

import type { Handle, Llm, Cache, Store, Ask, Checkpoint } from '../effects/types.js'
import { MemoryStore } from '../effects/types.js'
import type { Caps, Governor, SinkTarget, LeafFn } from '../op/types.js'
import { buildOp, type OpSpec } from '../op/spec.js'
import { SINK_REGISTRY } from '../op/sinks.js'
import { runInline, checkpointKey } from '../runtime/inline.js'
import type { RunGovernedOpts } from '../control/governor.js'
import { canonicalize } from '../control/retry.js'
import type { TraceEvent } from '../control/trace.js'
import { b64ToBytes, bytesToB64 } from './base64.js'

export type HandleRef = { $handle: true; base64: string; type?: string }

function isHandleRef(v: unknown): v is HandleRef {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>).$handle === true
    && typeof (v as Record<string, unknown>).base64 === 'string'
}

function isResolvedHandle(v: unknown): v is Handle {
  if (typeof v !== 'object' || v === null) return false
  const h = v as Record<string, unknown>
  return typeof h.r2Key === 'string' && typeof h.sha256 === 'string' && typeof h.type === 'string' && typeof h.size === 'number'
}

// Aggregate cap across every $handle ref a single hydrate() call decodes, not
// just each one individually -- b64ToBytes already caps one base64 string,
// but an input array/object can nest arbitrarily many refs, each passing
// that per-string cap while summing to unbounded MemoryStore growth. Mirrors
// archive_create's totalBytes pattern (mcp.ts) and is sized like
// http.ts's MAX_REQUEST_BODY_BYTES so an MCP call (which has no whole-request
// body cap the way POST /op/run does) can't exceed what an HTTP caller could
// already send in one request.
export const MAX_HYDRATE_BYTES = 50_000_000

// Bomb guard on trace: true's collected TraceEvent buffer, mirroring
// MAX_HYDRATE_BYTES above. map/mapField's OpSpec only range-checks
// `concurrency` (src/op/spec.ts's buildOp/validateOpSpec), never the length
// of the array being mapped over -- that's a property of the hydrated JSON
// input, not the spec -- so a modest request body piped through a `map`
// node with trace: true would otherwise grow this in-memory array without
// bound (one node-enter/node-exit pair per item visited), amplifying a
// small request into large uncapped server-side memory retention across
// HTTP/MCP/CLI, the one surface that pattern had been skipped on.
export const MAX_TRACE_EVENTS = 20_000

async function hydrate(store: Store, value: unknown, budget: { totalBytes: number }): Promise<unknown> {
  if (isHandleRef(value)) {
    const bytes = b64ToBytes(value.base64)
    budget.totalBytes += bytes.length
    if (budget.totalBytes > MAX_HYDRATE_BYTES) {
      throw new Error(`op-run input totals more than ${MAX_HYDRATE_BYTES} bytes across all $handle refs (bomb guard).`)
    }
    return store.put(bytes, value.type ?? 'application/octet-stream')
  }
  // A caller-supplied object shaped like an already-resolved Handle
  // (r2Key/sha256/type/size) must never reach a leaf unchanged -- that would
  // let a caller name another run's Store entry directly, bypassing the
  // $handle-ref minting this function exists to enforce (see the header
  // comment: "the caller never sees or invents a Store key itself").
  if (isResolvedHandle(value)) {
    throw new Error('op-run input may not contain a raw Handle object -- seed bytes via { $handle: true, base64, type? } instead.')
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => hydrate(store, v, budget)))
  if (value && typeof value === 'object') {
    // Object.create(null), not {}: a caller-supplied key literally named
    // "__proto__" assigned via out[k] = ... onto a plain {} would hit the
    // inherited Annex-B setter and hijack `out`'s own prototype to whatever
    // object the caller supplied, instead of creating an ordinary "__proto__"
    // data property -- letting later sibling keys silently resolve as
    // *inherited* properties from that object. Same class of bug CLAUDE.md
    // documents for fflate's zip entry names, here reachable via any JSON key.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = await hydrate(store, v, budget)
    return out
  }
  return value
}

async function dehydrate(store: Store, value: unknown): Promise<unknown> {
  if (isResolvedHandle(value)) {
    const bytes = await store.get(value)
    return { base64: bytesToB64(bytes), type: value.type, size: value.size }
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => dehydrate(store, v)))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = await dehydrate(store, v)
    return out
  }
  return value
}

const llmUnavailable: Llm = {
  markdownFromPdf: async () => { throw new Error('llm capability is not available via run_pipeline/op-run') },
  summarize: async () => { throw new Error('llm capability is not available via run_pipeline/op-run') },
}

/**
 * Binds a run's checkpoint ledger to the request that produced it (#398),
 * closing an IDOR: `runId` alone is a caller-supplied string over HTTP/MCP --
 * guessable, observable in a prior response, or simply reused -- and a
 * checkpoint keyed only by `(runId, path)` would let a request carrying
 * another run's `runId` but a *different* spec/input read that other run's
 * recorded leaf/sink output at any path the two op-tree shapes happen to
 * share. Hashes the caller-supplied `spec` JSON directly (not the `Op` tree
 * `buildOp` produces from it) plus the raw `input`, before hydrate() ever
 * runs -- a leaf spec's `params` (buildOp's mergeParams, see spec.ts) is
 * closed over a generated pipe step's `fn` and never appears as an
 * enumerable field on the built tree, so hashing the tree instead would miss
 * two specs that differ only in a leaf's params. Reuses retry.ts's
 * `canonicalize` so key order never affects the hash, same as
 * `idempotencyKey`/`memoKey`.
 */
async function runIdentity(spec: OpSpec, input: unknown): Promise<string> {
  const stable = JSON.stringify(canonicalize({ spec, input }))
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `trace`: opt-in per-call, for a stateless caller (HTTP/MCP/CLI) that wants
 * #215's per-node execution trace back without supplying a live
 * `gOpts.onTrace` callback of its own -- runOpSpec collects every emitted
 * `TraceEvent` into an array and returns `{ result, trace }` instead of the
 * bare result. Omitted (or `false`), runOpSpec's return value is unchanged
 * from before #228 (the bare dehydrated result), so every existing caller
 * asserting that shape keeps working untouched. A caller-supplied
 * `opts.gOpts.onTrace` still fires alongside the collector when both are
 * present -- `trace: true` doesn't replace a live callback, it adds a
 * buffered one.
 *
 * `runId`: opt-in, for a caller that wants to *resume* a previously
 * checkpointed run (#396) -- pass back the `runId` a prior call returned (see
 * `OpRunOpts.checkpoint` below) to share that run's checkpoint ledger,
 * letting already-completed nodes short-circuit instead of re-executing.
 * Omitted, runOpSpec mints a fresh one via `crypto.randomUUID()` itself
 * (rather than letting `runInline` default it internally) specifically so it
 * can hand the minted id back to the caller -- `runInline`'s own internal
 * default is otherwise unobservable from outside the call. A resume attempt
 * whose `spec`/`input` don't match the run `runId` originally ran under
 * misses the ledger entirely rather than reading that other run's results --
 * see `runIdentity` below (#398).
 */
export type OpRunRequest = { spec: OpSpec; input: unknown; trace?: boolean; runId?: string }

/**
 * Governors/cache/store a host wants shared across calls (createGovernor per
 * registry leaf, a persistent Cache, a persistent Store) -- CLAUDE.md's
 * "Governor convention" puts policy choices (thresholds, whether to cache at
 * all, what backs the Store) on the host, not this library, so these are
 * threaded through as-is rather than constructed here. Omitted entirely (the
 * pre-#119 behavior) still runs fine: retries still apply,
 * breaker/tokenBucket/concurrency gating and memoization just stay no-ops per
 * runGoverned's own degrade-gracefully pattern, and a fresh MemoryStore backs
 * each call as before.
 *
 * `cache` without also supplying `store` is a real footgun worth calling out:
 * every registry leaf's result is Handle-shaped somewhere in its output, and
 * a Handle only resolves against the Store instance that produced it -- a
 * cache hit on a *later* call whose Handle points into a now-discarded
 * per-call MemoryStore will throw ("handle not found") the moment the result
 * is dehydrated, not silently misbehave. Pass the same `store` alongside
 * `cache` (both long-lived) for cross-call memoization to actually work.
 *
 * `sinks`: host-supplied SinkTarget instances (a log, a queue, a second
 * store), merged alongside SINK_REGISTRY's built-in `store` target -- a spec
 * name matching a key here wins over SINK_REGISTRY, letting a host override
 * `store` too if it wants different re-put semantics. Omitted entirely still
 * leaves the built-in `store` target reachable, unlike governors/cache which
 * are pure no-ops when omitted.
 *
 * `llm`: a host-supplied Llm implementation (real network calls to whatever
 * model backs it are the host's responsibility -- this repo stays
 * dependency-light and never constructs one itself), threaded through to
 * `text.ts`'s `extract`/`summarize` leaves the same way `store`/`cache` are.
 * Omitted entirely, `caps.llm` falls back to `llmUnavailable` below, so those
 * two leaves throw a clear error instead of silently running with a
 * do-nothing capability.
 *
 * `leaves`: host-registered LeafFns merged onto LEAF_REGISTRY (src/op/
 * registry.ts's `mergeLeaves`, same host-overrides-built-in order as
 * `sinks`/SINK_REGISTRY), letting a caller-supplied OpSpec's `leaf.name`
 * resolve against logic this library never shipped -- a host embedding
 * suxlib (e.g. `sux`) registering its own leaf. Omitted entirely still
 * resolves every built-in registry leaf as before.
 *
 * `ask`: a host-supplied Ask implementation, threaded to `caps.ask` the same
 * way `store`/`cache`/`llm` are -- lets a caller-supplied OpSpec's `ask` step
 * (src/op/spec.ts) actually reach a human-in-the-loop answer instead of only
 * ever hitting runInline's no-capability-supplied fallback (`onTimeout:
 * 'fail'` throws `AskTimeoutError`, `'proceed'` passes the piped value
 * through). Omitted entirely, that fallback behavior is unchanged.
 *
 * `gOpts`: passed through unchanged as runInline's 4th argument -- the only
 * way to reach retry-attempt/memo-hit/memo-miss GovernorEvents (runGoverned
 * emits those directly from `gOpts.onEvent`, unlike breaker/tokenBucket/
 * concurrency events which are observable via a host-constructed `governors`
 * Governor's own onEvent) or to supply a custom backoff/sleep/rand. Host-only
 * config (carries function callbacks), same as governors/cache/store/leaves
 * above -- never JSON-caller-supplied. Omitted entirely, runInline's own
 * defaults apply as before.
 *
 * `checkpoint`: a host-supplied Checkpoint implementation (#390), threaded to
 * `caps.checkpoint` the same way `store`/`cache`/`llm` are -- lets a
 * `runId`-sharing pair of `runOpSpec` calls resume a crashed run instead of
 * re-executing every node from scratch. Omitted entirely, `caps.checkpoint`
 * stays undefined and every node runs unconditionally, same as before #390.
 * Supplying `checkpoint` without also supplying a long-lived `store` has the
 * same footgun as `cache` above -- a checkpointed node's Handle-shaped result
 * won't resolve against a fresh per-call MemoryStore on a resumed call.
 */
export type OpRunOpts = { governors?: Record<string, Governor>; cache?: Cache; store?: Store; sinks?: Record<string, SinkTarget>; llm?: Llm; leaves?: Record<string, LeafFn>; ask?: Ask; gOpts?: RunGovernedOpts; checkpoint?: Checkpoint }

/**
 * Executes one adapter-triggered pipeline run end to end: builds the Op tree
 * from `spec`, hydrates `input` into a Store (a fresh per-call MemoryStore by
 * default, or `opts.store` when the host supplies one), runs it via
 * runInline, and dehydrates the result back to plain JSON. `opts.governors`/
 * `opts.cache`/`opts.store`, when supplied, are expected to be long-lived
 * instances the host constructs once and passes to every call, so the
 * reliability primitives they gate (breaker trip state, token-bucket fill,
 * memoized results, handle data) actually persist across requests instead of
 * resetting on every stateless HTTP route / MCP tool call.
 *
 * When `opts.checkpoint` is supplied, the return value always carries the
 * `runId` this call ran under (minted fresh via `crypto.randomUUID()` when
 * the request didn't supply one) alongside `result`/`trace` -- a caller
 * without a checkpoint capability configured keeps getting the pre-#396
 * bare-result (or `{ result, trace }`) shape unchanged, since it has no way
 * to make use of a `runId` anyway.
 */
export async function runOpSpec({ spec, input, trace, runId }: OpRunRequest, opts: OpRunOpts = {}): Promise<unknown> {
  const store = opts.store ?? new MemoryStore()
  const sinks = Object.assign(Object.create(null), SINK_REGISTRY, opts.sinks) as Record<string, SinkTarget>
  const caps: Caps = { store, llm: opts.llm ?? llmUnavailable, clock: { now: () => Date.now() }, sinks, governors: opts.governors, cache: opts.cache, ask: opts.ask, checkpoint: opts.checkpoint }
  // Mint the runId here (rather than letting runInline default it
  // internally) so it can be handed back to the caller -- runInline's own
  // internal default would otherwise be unobservable from outside the call.
  const effectiveRunId = runId ?? crypto.randomUUID()
  // Only computed when a checkpoint capability is actually wired -- runSig
  // has nothing to bind otherwise (traced() ignores it whenever
  // caps.checkpoint is undefined), so this stays a no-op cost for every
  // caller that hasn't opted into checkpointing.
  const runSig = opts.checkpoint ? await runIdentity(spec, input) : ''
  const tree = buildOp(spec, opts.leaves)
  const hydrated = await hydrate(store, input, { totalBytes: 0 })
  let gOpts = opts.gOpts
  let events: TraceEvent[] | undefined
  if (trace) {
    events = []
    const collected = events
    const userOnTrace = opts.gOpts?.onTrace
    gOpts = {
      ...opts.gOpts,
      onTrace: (e) => {
        collected.push(e)
        // Fail loud, consistent with every other bomb guard in this file
        // (hydrate()'s MAX_HYDRATE_BYTES): abort the run rather than
        // silently truncating the trace and returning a partial-but-looks-
        // complete buffer to the caller.
        if (collected.length > MAX_TRACE_EVENTS) {
          throw new Error(`op-run trace collected more than ${MAX_TRACE_EVENTS} TraceEvents (bomb guard).`)
        }
        userOnTrace?.(e)
      },
    }
  }
  const result = await runInline(tree, hydrated, caps, gOpts, '', effectiveRunId, runSig)
  const dehydrated = await dehydrate(store, result)
  if (opts.checkpoint) {
    return trace ? { result: dehydrated, trace: events, runId: effectiveRunId } : { result: dehydrated, runId: effectiveRunId }
  }
  return trace ? { result: dehydrated, trace: events } : dehydrated
}

export type OpRunStatusRequest = { spec: OpSpec; input: unknown; runId: string }
export type OpRunStatusOpts = { checkpoint: Checkpoint; store?: Store }
export type OpRunStatus = { done: true; result: unknown } | { done: false }

/**
 * Cheap "has this checkpointed run finished, and if so what did it return"
 * query (#409) -- reads the exact root-node entry `runOpSpec`'s call into
 * runInline already leaves behind via `traced()` (src/runtime/inline.ts),
 * without re-executing (or even building) the op tree at all. `spec`/`input`
 * must be the same ones the original run used: recomputing `runIdentity`
 * here (rather than trusting a bare caller-supplied `runId`) is what closes
 * the same #398 IDOR class runOpSpec itself guards against -- a status
 * request naming a stranger's `runId` alongside a mismatched spec/input
 * misses the ledger entirely rather than reading that run's result.
 *
 * Deliberately narrow: `Checkpoint.get`/`put` only distinguish "done" from
 * "no entry yet" (src/effects/types.ts), so this can only ever answer `{
 * done: false }` for a run that's still in progress, crashed mid-run, or
 * never started -- there is no separate in-progress marker to report on.
 * Giving those cases distinct answers needs a real `Checkpoint` interface
 * extension (touching every implementation and every `traced()` call site),
 * which is out of scope here -- see #409's own issue text.
 *
 * `opts.store`, when supplied, dehydrates a Handle-shaped recorded result
 * back to base64 the same way `runOpSpec` does -- omit it only when the
 * original run's result is known to contain no Handles, or the caller wants
 * the raw (still-Handle-shaped) value back.
 */
export async function runOpSpecStatus({ spec, input, runId }: OpRunStatusRequest, opts: OpRunStatusOpts): Promise<OpRunStatus> {
  const runSig = await runIdentity(spec, input)
  const recorded = await opts.checkpoint.get(checkpointKey(runId, runSig), '')
  if (!recorded) return { done: false }
  return { done: true, result: opts.store ? await dehydrate(opts.store, recorded.value) : recorded.value }
}
