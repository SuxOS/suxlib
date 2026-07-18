import type { Store, Llm, Clock, Ask, Cache } from '../effects/types.js'
import type { ReconcileOpts } from './reconcile.js'
import type { TokenBucket } from '../control/token-bucket.js'
import type { CircuitBreaker } from '../control/circuit-breaker.js'
export interface SinkTarget { name: string; write(input: any, caps: Caps): Promise<any> }
export interface Governor { tokenBucket?: TokenBucket; circuitBreaker?: CircuitBreaker; concurrency?: Concurrency; heavyConcurrency?: Concurrency }
export interface Caps { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget>; governors?: Record<string, Governor>; ask?: Ask; cache?: Cache }
export interface Concurrency { acquire(): Promise<void>; release(ok: boolean): void }
// memoKeyExtra folds a leaf-instance-specific value (e.g. buildOp's static
// `params`, merged into the input only inside the leaf's own fn closure,
// after the memo lookup already ran) into the memo cache key -- otherwise two
// leaf nodes sharing a name+input but differing params would collide on the
// same key. Distinct from LeafFn's opaque input to keep this optional and
// leaf-fn-agnostic.
export interface LeafOpts { kind: 'pure' | 'effect'; retries?: number; heavy?: boolean; memo?: boolean; memoKeyExtra?: unknown }
export type LeafFn = (input: any, caps: Caps, idempotencyKey?: string) => Promise<any>
export type Op =
  | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
  | { tag: 'pipe'; steps: Op[] }
  | { tag: 'map'; op: Op; concurrency: Concurrency }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
