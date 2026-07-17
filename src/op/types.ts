import type { Store, Llm, Clock } from '../effects/types.js'
import type { ReconcileOpts } from './reconcile.js'
import type { TokenBucket } from '../control/token-bucket.js'
import type { CircuitBreaker } from '../control/circuit-breaker.js'
export interface SinkTarget { name: string; write(input: any, caps: Caps): Promise<any> }
export interface Governor { tokenBucket?: TokenBucket; circuitBreaker?: CircuitBreaker }
export interface Caps { store: Store; llm: Llm; clock: Clock; sinks: Record<string, SinkTarget>; governors?: Record<string, Governor> }
export interface Concurrency { acquire(): Promise<void>; release(ok: boolean): void }
export interface LeafOpts { kind: 'pure' | 'effect'; heavy?: boolean; retries?: number; effort?: 'cheap' | 'auto' | 'max' }
export type LeafFn = (input: any, caps: Caps) => Promise<any>
export type Op =
  | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
  | { tag: 'pipe'; steps: Op[] }
  | { tag: 'map'; op: Op; concurrency: Concurrency }
  | { tag: 'reconcile'; opts: ReconcileOpts }
  | { tag: 'sink'; targets: string[] }
  | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
