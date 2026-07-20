import type { Store, Llm, Clock, Ask, Cache } from '../effects/types.js'
import type { ReconcileOpts } from './reconcile.js'
import type { TokenBucket } from '../control/token-bucket.js'
import type { CircuitBreaker } from '../control/circuit-breaker.js'
export interface SinkTarget { name: string; write(input: any, caps: Caps): Promise<any> }
export interface Governor { tokenBucket?: TokenBucket; circuitBreaker?: CircuitBreaker; concurrency?: Concurrency; heavyConcurrency?: Concurrency }
export interface Caps { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget>; governors?: Record<string, Governor>; ask?: Ask; cache?: Cache }
// releaseCancelled is optional so existing Concurrency implementations keep
// compiling; a caller releasing a slot for a cooperative abort (not a real
// leaf failure) should prefer it over release(false), which would otherwise
// mis-punish an AIMD limiter's throughput for a cancellation (#309).
export interface Concurrency { acquire(signal?: AbortSignal): Promise<void>; release(ok: boolean, runId?: string): void; releaseCancelled?(runId?: string): void }
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
export type Op =
  | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
  | { tag: 'pipe'; steps: Op[] }
  | { tag: 'map'; op: Op; concurrency: Concurrency }
  | { tag: 'mapField'; arrayField: string; elementField: string; op: Op; concurrency: Concurrency; renameTo?: string }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'sink'; targets: SinkFanoutTarget[]; opts?: SinkOpts }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
  | { tag: 'catch'; try: Op; catch: Op }
