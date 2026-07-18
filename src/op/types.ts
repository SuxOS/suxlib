import type { Store, Llm, Clock, Ask, Cache } from '../effects/types.js'
import type { ReconcileOpts } from './reconcile.js'
import type { TokenBucket } from '../control/token-bucket.js'
import type { CircuitBreaker } from '../control/circuit-breaker.js'
export interface SinkTarget { name: string; write(input: any, caps: Caps): Promise<any> }
export interface Governor { tokenBucket?: TokenBucket; circuitBreaker?: CircuitBreaker; concurrency?: Concurrency; heavyConcurrency?: Concurrency }
export interface Caps { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget>; governors?: Record<string, Governor>; ask?: Ask; cache?: Cache }
export interface Concurrency { acquire(): Promise<void>; release(ok: boolean): void }
export interface LeafOpts { kind: 'pure' | 'effect'; retries?: number; heavy?: boolean; memo?: boolean }
export type LeafFn = (input: any, caps: Caps, idempotencyKey?: string) => Promise<any>
export type Op =
  | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
  | { tag: 'pipe'; steps: Op[] }
  | { tag: 'map'; op: Op; concurrency: Concurrency }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
