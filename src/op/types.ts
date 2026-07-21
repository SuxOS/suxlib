import type { Store, Llm, Clock, Ask, Cache, Checkpoint } from '../effects/types.js'
import type { ReconcileOpts } from './reconcile.js'
import type { TokenBucket } from '../control/token-bucket.js'
import type { CircuitBreaker } from '../control/circuit-breaker.js'
export interface SinkTarget { name: string; write(input: any, caps: Caps): Promise<any> }
export interface Governor { tokenBucket?: TokenBucket; circuitBreaker?: CircuitBreaker; concurrency?: Concurrency; heavyConcurrency?: Concurrency }
// `checkpoint` is optional, same degrade-gracefully pattern as `ask`/`cache`:
// with none supplied, runInline's traced() (src/runtime/inline.ts) never
// consults it and every node re-executes on every call, today's behavior
// unchanged.
export interface Caps { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget>; governors?: Record<string, Governor>; ask?: Ask; cache?: Cache; checkpoint?: Checkpoint }
// releaseNeutral() is for a slot abandoned by cancellation (OpAbortError), not by
// leaf success/failure -- it must free the slot without counting toward an aimd
// limiter's success-streak or failure-halving, since the leaf never actually ran
// to a real outcome (#309). Optional so existing ad-hoc test/host Concurrency
// literals built before this field existed keep type-checking; callers fall back
// to a plain release(true) (still not a failure-charge) when it's absent.
export interface Concurrency { acquire(signal?: AbortSignal): Promise<void>; release(ok: boolean, runId?: string, callId?: string): void; releaseNeutral?(runId?: string, callId?: string): void }
export interface LeafOpts { kind: 'pure' | 'effect'; retries?: number; heavy?: boolean; memo?: boolean }
// A sink write is always I/O (there's no 'pure' sink), so unlike LeafOpts
// there's no `kind` to declare -- runGoverned gates it the same way it gates
// an 'effect' leaf.
export interface SinkOpts { retries?: number; heavy?: boolean; memo?: boolean }
// A fanout target is either a bare name (falls back entirely to the sink
// node's own `opts`, #247's original shape) or a `{ name, opts }` pair whose
// `opts` fields individually override the node-level default -- #251: lets
// one `sink.fanout` call give target 'log' retries: 3 while target 'vault'
// gets retries: 0, without composing two separate sink() nodes via pipe.
export type SinkFanoutTarget = string | { name: string; opts?: SinkOpts }
export type LeafFn = (input: any, caps: Caps, idempotencyKey?: string) => Promise<any>
// A constrained, declarative predicate language for `cond` (#196) -- deliberately
// not arbitrary injected code, since a predicate can arrive over an unauthenticated
// adapter call (POST /op/run) the same way an OpSpec leaf name/params can. `field`
// addresses a top-level key of the piped value; omitted, it compares the piped
// value itself (the only option for a primitive input) -- exactly one of
// `equals`/`in` is checked against that resolved value.
export type CondPrimitive = string | number | boolean | null
export type CondPredicate =
  | { field?: string; equals: CondPrimitive }
  | { field?: string; in: CondPrimitive[] }
export type Op =
  | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
  | { tag: 'pipe'; steps: Op[] }
  | { tag: 'map'; op: Op; concurrency: Concurrency }
  | { tag: 'mapField'; arrayField: string; elementField: string; op: Op; concurrency: Concurrency; renameTo?: string }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'sink'; targets: SinkFanoutTarget[]; opts?: SinkOpts }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
  | { tag: 'catch'; try: Op; catch: Op }
  | { tag: 'cond'; cases: { when: CondPredicate; then: Op }[]; default?: Op }
  // Fans one input into N arbitrary op subtrees, run concurrently over the
  // *same* piped value (unlike map's one-input-per-array-element fan-out),
  // collecting each branch's result into an array in `ops` order -- e.g.
  // `pipe(parallel([opA, opB, opC]), reconcile(...))` to transform one
  // document three different ways and merge the results (#289).
  | { tag: 'parallel'; ops: Op[] }
  // Fans one input into N branches like `parallel`, but settles as soon as
  // `need` (default 1, i.e. first-success-wins) of them succeed instead of
  // waiting on every branch -- redundant-provider patterns (three redundant
  // LLM backends, take whichever answers first; write to 3 sinks, require
  // 2-of-3 for a durability quorum) that `parallel`'s wait-for-all and
  // `cond`'s pick-exactly-one-ahead-of-time can't express (#429). Resolves
  // with an array of the winning branches' results in *settle* order (not
  // declaration order -- there's no other order early settlement could use),
  // always length `need` regardless of `need`'s value, so a downstream step
  // gets one consistent shape rather than an ergonomic bare-value special
  // case for `need: 1`. Rejects once success becomes mathematically
  // unreachable (too many branches have already failed), not just once every
  // branch has settled -- a losing branch that's still mid-flight when the
  // node settles keeps running to completion (cooperative cancellation only
  // stops it from *starting* further work, same #279 contract every other
  // node honors); it is never preemptively killed.
  | { tag: 'race'; ops: Op[]; need?: number }
