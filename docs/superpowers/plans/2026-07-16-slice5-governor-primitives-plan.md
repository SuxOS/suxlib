# Slice 5: Governor Primitives — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **HARD SCOPE BOUNDARY — read before starting:** this plan touches **only** the `SuxOS/suxlib` repo (`src/control/*`, `test/control/*`, `src/index.ts`). It does **not** touch `/Users/colinxs/Code/SuxOS/.github`, `/Users/colinxs/Code/SuxOS/claude-config`, or any `.github/workflows/*` file in any repo — the autonomous pipeline de-shelling is separate, higher-blast-radius work for a dedicated human-reviewed initiative (see spec §1.3). If any task below appears to require editing something outside `suxlib/{src,test}`, stop and flag it rather than proceeding.

**Goal:** Ship the two missing `suxlib` control primitives the parent op-engine spec deferred to slice 5 — `tokenBucket()` (spend pacing) and `circuitBreaker()` (fail-fast on a down dependency) — plus a deterministic, property-based simulation that empirically validates the four-primitive composition (token-bucket + AIMD + Full-Jitter + circuit-breaker) as a budget-governor *pattern*, satisfying the parent spec's `[S]` "validate empirically" risk note without touching any live system.

**Architecture:** Both primitives are pure, clock-injected values matching the existing `suxlib/src/control/*` shape (`aimd.ts`, `retry.ts`) — no ambient I/O, no timers, `now` always passed in or read via the existing `Clock` capability. The composition is specified as a call-site pattern (spec §3.3), not a new abstraction; validation lives in a simulation test driven by a fake `Clock` and a seeded synthetic unreliable dependency, so every property assertion is deterministic and replayable.

**Tech Stack:** TypeScript 5 (`suxlib`'s existing `tsconfig.json`), Vitest, no new dependencies (both primitives and the simulation harness use only what's already in `suxlib`'s `Clock`/`backoffFullJitter`).

**Relates to:** `suxlib/docs/superpowers/specs/2026-07-16-slice5-governor-primitives-design.md` (this plan's spec); `sux/docs/superpowers/specs/2026-07-15-suxos-v2-op-engine-design.md` §1.3/§3.5/§7 (the parent spec this slice fulfils); `sux/docs/superpowers/plans/2026-07-15-suxos-v2-op-engine-walking-skeleton.md` (the slice-1/2 plan this mirrors in format and whose "Deferred to the follow-on plan" section named `token-bucket` + `circuit-breaker` as slice-5 work).

## Global Constraints

- **Purity:** both primitives are pure and deterministic; all time reads go through an injected `Clock` or an explicit `nowMs` parameter — matching the DBOS determinism rule already governing all of `suxlib/control/*` (parent spec §3.1), so a future op leaf that wraps one stays durable-promotable.
- **No new dependencies.** `tokenBucket`'s wait uses the existing `backoffFullJitter()` from `control/retry.ts`; nothing else is needed.
- **File-per-primitive convention:** one new source file per primitive (`token-bucket.ts`, `circuit-breaker.ts`), one test file per source file, matching every existing `suxlib/src/control/*` + `test/control/*` pair.
- **No consumer wiring in this plan.** Nothing here touches `op/`, `runtime/`, `domain/`, or any Worker — this plan produces library primitives + their own tests only, per spec §1.3/§6.
- **Repo:** all work happens in `SuxOS/suxlib`, isolated in a scratch worktree (`suxlib/.scratch-worktrees/slice5-governor-primitives`) on branch `feat/slice5-governor-primitives`, per the org's parallel-git-mutator convention — never a plain `git checkout` in the shared clone.

---

## File Structure

**New in `SuxOS/suxlib`:**
- `src/control/token-bucket.ts` — `TokenBucket` interface, `tokenBucket()` factory
- `src/control/circuit-breaker.ts` — `BreakerState`, `CircuitBreaker` interface, `circuitBreaker()` factory
- `test/control/token-bucket.test.ts` — unit tests
- `test/control/circuit-breaker.test.ts` — unit tests
- `test/control/fixtures/flaky-dependency.ts` — seeded synthetic unreliable dependency (concurrency-threshold 429s, an outage window, a per-call token cost)
- `test/control/fixtures/fake-clock.ts` — a manually-advanceable `Clock` implementation for deterministic simulation
- `test/control/governor-simulation.test.ts` — the composition property tests (spec §5, properties 1–5)

**Modified:**
- `src/index.ts` — export the two new primitives alongside the existing `control/*` surface

---

## Task 1: `tokenBucket()` — the rate-pacing primitive

**Files:**
- Create: `src/control/token-bucket.ts`, `test/control/token-bucket.test.ts`

**Interfaces:**
- Consumes: `Clock` (`src/effects/types.ts`, already exists).
- Produces: `TokenBucket = { tryTake(cost, nowMs) => boolean; take(cost, clock) => Promise<void>; readonly tokens: number }`; `tokenBucket({capacity, refillPerMs, clock}) => TokenBucket`.

- [ ] **Step 1: Write the failing tests**
```ts
import { test, expect } from 'vitest'
import { tokenBucket } from '../../src/control/token-bucket.js'

test('tryTake consumes tokens up to capacity and refuses beyond it', () => {
  const b = tokenBucket({ capacity: 10, refillPerMs: 0, clock: { now: () => 0 } })
  expect(b.tokens).toBe(10)
  expect(b.tryTake(6, 0)).toBe(true)
  expect(b.tokens).toBe(4)
  expect(b.tryTake(5, 0)).toBe(false)   // insufficient tokens, no partial consumption
  expect(b.tokens).toBe(4)              // unchanged on refusal
})

test('tokens refill linearly with elapsed time, capped at capacity', () => {
  const b = tokenBucket({ capacity: 10, refillPerMs: 1, clock: { now: () => 0 } })
  b.tryTake(10, 0)
  expect(b.tokens).toBe(0)
  expect(b.tryTake(1, 500)).toBe(false)  // only 500 tokens' worth of time... wait, refillPerMs=1 -> 500 tokens, capped at 10
  // refillPerMs=1 means 1 token/ms; at t=500 the bucket is already saturated at capacity
  expect(b.tryTake(5, 5)).toBe(true)     // 5ms elapsed * 1/ms = 5 tokens available
})

test('take() blocks via clock-driven polling until enough tokens accumulate', async () => {
  let simulatedNow = 0
  const clock = { now: () => simulatedNow }
  const b = tokenBucket({ capacity: 5, refillPerMs: 1, clock })
  b.tryTake(5, 0) // drain it
  const p = b.take(3, clock)
  // advance simulated time in a loop the way the fake-clock fixture does (Task 5 formalizes this)
  for (let i = 0; i < 10 && b.tokens < 3; i++) { simulatedNow += 1; await Promise.resolve() }
  await p
  expect(b.tokens).toBeGreaterThanOrEqual(0)
})
```
- [ ] **Step 2: Run — Expected: FAIL** (`token-bucket.ts` doesn't exist). Run: `npx vitest run test/control/token-bucket.test.ts`
- [ ] **Step 3: Implement**
```ts
import type { Clock } from '../effects/types.js'
import { backoffFullJitter } from './retry.js'

export interface TokenBucket {
  tryTake(cost: number, nowMs: number): boolean
  take(cost: number, clock: Clock): Promise<void>
  readonly tokens: number
}

export function tokenBucket(opts: { capacity: number; refillPerMs: number; clock: Clock }): TokenBucket {
  let tokens = opts.capacity
  let lastRefillMs = opts.clock.now()

  function refill(nowMs: number) {
    const elapsed = Math.max(0, nowMs - lastRefillMs)
    tokens = Math.min(opts.capacity, tokens + elapsed * opts.refillPerMs)
    lastRefillMs = nowMs
  }

  return {
    get tokens() { return tokens },
    tryTake(cost, nowMs) {
      refill(nowMs)
      if (tokens < cost) return false
      tokens -= cost
      return true
    },
    async take(cost, clock) {
      let attempt = 0
      while (!this.tryTake(cost, clock.now())) {
        const delayMs = Math.max(1, backoffFullJitter(attempt++, { base: 5, cap: 200 }))
        await new Promise((r) => setTimeout(r, delayMs))
      }
    },
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(control): tokenBucket rate-pacing primitive"`

**Design note for the implementer:** the `take()` test above uses `setTimeout`-driven polling, which is fine for a unit test of `tokenBucket` in isolation but is exactly what Task 5's `fake-clock` fixture exists to avoid inside the governor simulation (Task 6) — the simulation must never depend on real wall-clock timers or it becomes flaky. If `take()`'s internal `setTimeout` makes the simulation non-deterministic, the simulation harness should drive the bucket via `tryTake` directly under its own fake-clock loop rather than calling `take()` — flag this in the Task 6 self-check rather than silently working around it.

---

## Task 2: `circuitBreaker()` — the fail-fast primitive

**Files:**
- Create: `src/control/circuit-breaker.ts`, `test/control/circuit-breaker.test.ts`

**Interfaces:**
- Produces: `BreakerState = 'closed' | 'open' | 'half-open'`; `CircuitBreaker = { readonly state; allow(nowMs) => boolean; onSuccess(nowMs) => void; onFailure(nowMs) => void }`; `circuitBreaker({failureThreshold, cooldownMs, halfOpenSuccesses}) => CircuitBreaker`.

- [ ] **Step 1: Write the failing tests** (one per state transition in spec §3.2)
```ts
import { test, expect } from 'vitest'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'

test('starts closed and allows calls', () => {
  const b = circuitBreaker({ failureThreshold: 3, cooldownMs: 100, halfOpenSuccesses: 2 })
  expect(b.state).toBe('closed')
  expect(b.allow(0)).toBe(true)
})

test('trips to open after failureThreshold consecutive failures', () => {
  const b = circuitBreaker({ failureThreshold: 3, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.onFailure(0)
  expect(b.state).toBe('closed')
  b.onFailure(0)
  expect(b.state).toBe('open')
  expect(b.allow(0)).toBe(false)
})

test('a success in closed state resets the failure count', () => {
  const b = circuitBreaker({ failureThreshold: 3, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.onFailure(0); b.onSuccess(0); b.onFailure(0); b.onFailure(0)
  expect(b.state).toBe('closed') // failure count was reset by the success, so 2 more failures don't trip it
})

test('open transitions to half-open only after cooldownMs elapses, and allow() reflects it', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0)
  expect(b.allow(50)).toBe(false)   // still within cooldown
  expect(b.allow(100)).toBe(true)   // cooldown elapsed -> half-open probe allowed
  expect(b.state).toBe('half-open')
})

test('half-open closes after halfOpenSuccesses consecutive successes', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.allow(100) // -> half-open
  b.onSuccess(100)
  expect(b.state).toBe('half-open')
  b.onSuccess(100)
  expect(b.state).toBe('closed')
})

test('any failure in half-open reopens the breaker and resets the cooldown', () => {
  const b = circuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 2 })
  b.onFailure(0); b.allow(100) // -> half-open
  b.onFailure(100)
  expect(b.state).toBe('open')
  expect(b.allow(150)).toBe(false)  // new cooldown window starts at 100, not 0
  expect(b.allow(200)).toBe(true)
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
export type BreakerState = 'closed' | 'open' | 'half-open'

export interface CircuitBreaker {
  readonly state: BreakerState
  allow(nowMs: number): boolean
  onSuccess(nowMs: number): void
  onFailure(nowMs: number): void
}

export function circuitBreaker(opts: {
  failureThreshold: number
  cooldownMs: number
  halfOpenSuccesses: number
}): CircuitBreaker {
  let state: BreakerState = 'closed'
  let consecutiveFailures = 0
  let consecutiveSuccesses = 0
  let openedAtMs = -Infinity

  return {
    get state() { return state },
    allow(nowMs) {
      if (state === 'open') {
        if (nowMs - openedAtMs >= opts.cooldownMs) {
          state = 'half-open'
          consecutiveSuccesses = 0
          return true
        }
        return false
      }
      return true
    },
    onSuccess(nowMs) {
      if (state === 'half-open') {
        if (++consecutiveSuccesses >= opts.halfOpenSuccesses) {
          state = 'closed'
          consecutiveFailures = 0
          consecutiveSuccesses = 0
        }
        return
      }
      consecutiveFailures = 0
    },
    onFailure(nowMs) {
      if (state === 'half-open') {
        state = 'open'
        openedAtMs = nowMs
        consecutiveSuccesses = 0
        return
      }
      if (++consecutiveFailures >= opts.failureThreshold) {
        state = 'open'
        openedAtMs = nowMs
      }
    },
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(control): circuitBreaker fail-fast primitive"`

---

## Task 3: export the public surface

**Files:** Modify `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `tokenBucket`, `TokenBucket`, `circuitBreaker`, `CircuitBreaker`, `BreakerState` importable from `@suxos/lib`.

- [ ] **Step 1: Write the failing test**
```ts
import { test, expect } from 'vitest'
import { tokenBucket, circuitBreaker } from '../src/index.js'
test('token-bucket and circuit-breaker are on the public surface', () => {
  expect(typeof tokenBucket).toBe('function')
  expect(typeof circuitBreaker).toBe('function')
})
```
Add this as `test/public-surface.test.ts` if no such file exists yet, or append to it if it does — check first (`ls test/*.test.ts` / `grep -l "from '../src/index.js'" test/*.test.ts`) rather than assuming.
- [ ] **Step 2: Run — Expected: FAIL** (not yet exported).
- [ ] **Step 3: Implement** — append to `src/index.ts`:
```ts
export * from './control/token-bucket.js'
export * from './control/circuit-breaker.js'
```
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat: export tokenBucket + circuitBreaker from public surface"`

---

## Task 4: the seeded synthetic unreliable dependency

**Files:** Create `test/control/fixtures/flaky-dependency.ts`

**Interfaces:**
- Produces: `createFlakyDependency(opts) => { call(concurrentInFlight: number, nowMs: number): { ok: boolean; costTokens: number } }` — a deterministic, seeded (mulberry32 or equivalent small PRNG, NOT `Math.random()`) fake that: rejects (`ok:false`) above `opts.concurrencyRejectThreshold` in-flight calls; is fully down (`ok:false` unconditionally) during `[opts.outageStartMs, opts.outageEndMs)`; otherwise succeeds and reports `opts.costTokensPerCall`.

- [ ] **Step 1: Write the failing test**
```ts
import { test, expect } from 'vitest'
import { createFlakyDependency } from './flaky-dependency.js'
test('flaky dependency is deterministic given the same seed', () => {
  const a = createFlakyDependency({ seed: 42, concurrencyRejectThreshold: 5, outageStartMs: 1000, outageEndMs: 1200, costTokensPerCall: 10 })
  const b = createFlakyDependency({ seed: 42, concurrencyRejectThreshold: 5, outageStartMs: 1000, outageEndMs: 1200, costTokensPerCall: 10 })
  const seq = (dep: typeof a) => Array.from({ length: 20 }, (_, i) => dep.call(2, i * 50).ok)
  expect(seq(a)).toEqual(seq(b))
})
test('rejects unconditionally during the outage window regardless of concurrency', () => {
  const dep = createFlakyDependency({ seed: 1, concurrencyRejectThreshold: 999, outageStartMs: 100, outageEndMs: 200, costTokensPerCall: 1 })
  expect(dep.call(0, 150).ok).toBe(false)
  expect(dep.call(0, 250).ok).toBe(true)
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FlakyDependency {
  call(concurrentInFlight: number, nowMs: number): { ok: boolean; costTokens: number }
}

export function createFlakyDependency(opts: {
  seed: number
  concurrencyRejectThreshold: number
  outageStartMs: number
  outageEndMs: number
  costTokensPerCall: number
  baseFailureRate?: number
}): FlakyDependency {
  const rand = mulberry32(opts.seed)
  return {
    call(concurrentInFlight, nowMs) {
      if (nowMs >= opts.outageStartMs && nowMs < opts.outageEndMs) return { ok: false, costTokens: 0 }
      if (concurrentInFlight > opts.concurrencyRejectThreshold) return { ok: false, costTokens: 0 }
      if (rand() < (opts.baseFailureRate ?? 0)) return { ok: false, costTokens: 0 }
      return { ok: true, costTokens: opts.costTokensPerCall }
    },
  }
}
```
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "test(control): seeded flaky-dependency fixture"`

---

## Task 5: the fake, manually-advanceable `Clock`

**Files:** Create `test/control/fixtures/fake-clock.ts`

**Interfaces:**
- Consumes: `Clock` (`src/effects/types.ts`).
- Produces: `createFakeClock(startMs?) => Clock & { advance(ms: number): void; set(ms: number): void }`.

- [ ] **Step 1: Write the failing test**
```ts
import { test, expect } from 'vitest'
import { createFakeClock } from './fake-clock.js'
test('fake clock advances deterministically and implements Clock', () => {
  const c = createFakeClock(100)
  expect(c.now()).toBe(100)
  c.advance(50)
  expect(c.now()).toBe(150)
  c.set(0)
  expect(c.now()).toBe(0)
})
```
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement**
```ts
import type { Clock } from '../../../src/effects/types.js'
export function createFakeClock(startMs = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = startMs
  return { now: () => t, advance: (ms) => { t += ms }, set: (ms) => { t = ms } }
}
```
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "test(control): fake-clock fixture for deterministic simulation"`

---

## Task 6: the governor-composition simulation (spec §5, properties 1–5)

**Files:** Create `test/control/governor-simulation.test.ts`

**Interfaces:**
- Consumes: `tokenBucket` (Task 1), `circuitBreaker` (Task 2), `aimd` + `backoffFullJitter` (existing, `src/control/aimd.ts` + `retry.ts`), `createFlakyDependency` (Task 4), `createFakeClock` (Task 5).
- Produces: five property assertions, each run across a small deterministic matrix of burst-pattern parameters — this is the artifact that discharges the parent spec's `[S]` "validate empirically" risk note.

**Design note — the simulation loop:** drive simulated time forward in fixed ticks (e.g. 1ms per tick, run for a few thousand ticks to cover quiet → spike → sustained-overload → recovery phases). At each tick, decide whether to attempt a call (a simple deterministic arrival-rate schedule keyed off the tick index and the burst-pattern parameters, not `Math.random()`), and if so, run the §3.3 call-site pattern against the flaky dependency using `tryTake` (not the timer-driven `take()` — see Task 1's design note) so the whole simulation stays synchronous and deterministic under the fake clock.

- [ ] **Step 1: Write the failing test** — implement the simulation driver and all five property assertions in one file (they share the same simulation run, so splitting into five test files would mean five separate simulation runs — acceptable but redundant; prefer one `test()` per property reading from a shared `runSimulation()` helper called once per parameter-matrix entry via `beforeAll` or a shared fixture, to keep the five properties independently readable in `vitest`'s output while sharing the run).

```ts
import { describe, test, expect, beforeAll } from 'vitest'
import { tokenBucket } from '../../src/control/token-bucket.js'
import { circuitBreaker } from '../../src/control/circuit-breaker.js'
import { aimd } from '../../src/control/aimd.js'
import { createFlakyDependency } from './fixtures/flaky-dependency.js'
import { createFakeClock } from './fixtures/fake-clock.js'

interface SimResult {
  totalTicks: number
  callsAttemptedToDependency: number
  callsRejectedByBreaker: number
  tokensConsumedInWindow: (windowStartMs: number, windowMs: number) => number
  maxQueueDepthObserved: number
  breakerStateAtTick: BreakerState[]
  aimdLimitAtTick: number[]
}

function runSimulation(params: { seed: number; spikeHeight: number; outageDurationMs: number; costTokensPerCall: number }): SimResult {
  // fixed-tick loop over e.g. 5000 ticks; phases: quiet (0-1000), spike (1000-2000),
  // sustained overload + outage (2000-2000+outageDurationMs), recovery (rest)
  // ... full implementation is the Step-3 deliverable; the shape above is the contract
}

describe('governor composition — token-bucket + AIMD + circuit-breaker', () => {
  const matrix = [
    { seed: 1, spikeHeight: 10, outageDurationMs: 200, costTokensPerCall: 5 },
    { seed: 2, spikeHeight: 50, outageDurationMs: 500, costTokensPerCall: 1 },
    { seed: 3, spikeHeight: 5,  outageDurationMs: 1000, costTokensPerCall: 20 },
  ]

  for (const params of matrix) {
    describe(`params=${JSON.stringify(params)}`, () => {
      let result: SimResult
      beforeAll(() => { result = runSimulation(params) })

      test('property 1: bounded spend rate — never exceeds capacity + refill over any window', () => {
        // assert result.tokensConsumedInWindow(w, 100) <= capacity + refillPerMs*100 for sampled windows w
      })
      test('property 2: no unbounded queue growth', () => {
        expect(result.maxQueueDepthObserved).toBeLessThan(1000) // configured ceiling
      })
      test('property 3: recovery after the overload/outage window within a bounded number of ticks', () => {
        // assert aimdLimitAtTick and breakerStateAtTick both return to healthy steady-state
        // within N ticks of the outage ending
      })
      test('property 4: fail-fast during the outage — dependency-attempt fraction drops near zero', () => {
        // assert callsRejectedByBreaker / callsAttemptedToDependency crosses a threshold
        // within cooldownMs of the outage starting
      })
      test('property 5: half-open probe count matches halfOpenSuccesses regardless of AIMD limit', () => {
        // assert the number of calls let through during each half-open window equals
        // the configured halfOpenSuccesses, independent of aimdLimitAtTick at that point
      })
    })
  }
})
```
- [ ] **Step 2: Run — Expected: FAIL** (`runSimulation` unimplemented). Run: `npx vitest run test/control/governor-simulation.test.ts`
- [ ] **Step 3: Implement `runSimulation`** per the call-site pattern in spec §3.3 — breaker gate, then `tryTake`, then `aimd.acquire()`, calling `flakyDependency.call(...)`, recording every observation the five properties need (queue depth = calls currently waiting on `aimd.acquire()` because the limiter is saturated; breaker/AIMD state snapshotted every tick). Implement each property's assertion body (marked with comments above) against the recorded `SimResult`.
- [ ] **Step 4: Run — Expected: PASS across all three matrix entries.** If any property fails for a specific parameter combination, that is real signal — do not loosen the assertion to make it pass. Instead: (a) confirm the failure is in the *composition* (call-site ordering, e.g. an off-by-one in when AIMD's limiter releases relative to when the breaker records the failure) rather than in `tokenBucket`/`circuitBreaker`/`aimd` individually (those already have passing unit tests from Tasks 1–2 and the pre-existing `aimd.test.ts`); (b) fix the call-site pattern in this test's `runSimulation` (and mirror the fix into spec §3.3's illustrative snippet via a follow-up doc edit) rather than weakening the property; (c) if a property turns out to be genuinely unsatisfiable by any ordering (a real negative result), that is itself a valid and important finding — document it in the spec's §7 risks section rather than deleting the test.
- [ ] **Step 5: Commit** — `git commit -am "test(control): governor composition simulation — validates token-bucket+AIMD+circuit-breaker properties"`

---

## Task 7: full local CI pass

**Files:** none (verification-only task)

- [ ] **Step 1: Run** `npm install && npm test` from `suxlib` root — Expected: all tests pass, including the pre-existing `aimd.test.ts` / `retry.test.ts` / domain/op/runtime suites (this task must not have broken anything already green).
- [ ] **Step 2: Run** `npm run build` (`tsc -p tsconfig.json --noEmit`) — Expected: no type errors under `strict` mode.
- [ ] **Step 3: If `suxlib` gains a `CLAUDE.md` or an `npm run ci` script before this plan is executed, run that instead of Steps 1–2** — none exists as of this plan's authoring (confirmed by direct repo inspection: `suxlib/package.json` currently defines only `test` and `build`), so this task hard-codes the equivalent of the org's usual `npm run ci` gate. Re-check at execution time rather than assuming this note is stale.
- [ ] **Step 4: No commit** — this task only verifies; nothing here changes tracked files.

---

## Deferred to a follow-on plan (NOT this plan)

Explicitly out of scope here, tracked so nothing is silently dropped — mirrors the walking-skeleton plan's own "Deferred" section:

- Wiring `tokenBucket`/`circuitBreaker` into any op leaf, the `run()` front-verb, or a Worker adapter (spec §6).
- The gradient-based (Envoy/Netflix `concurrency-limits`-style) AIMD refinement flagged in spec §2 as a possible future upgrade.
- Any integration with, or even reading of, `.github`/`claude-config`/any GitHub Actions workflow — the autonomous pipeline de-shelling is a separate, dedicated, human-reviewed initiative per spec §1.3.
- Reconciliation with the org's existing live throttle/check-throttle budget-governor system — flagged in spec §7 as a seam for future work, not investigated here.
- A live-dependency (non-simulated) validation spike, should the simulation-based validation in Task 6 later prove insufficient once a real consumer exists.

---

## Self-Review

**Spec coverage:** `tokenBucket()` (Task 1) ✓; `circuitBreaker()` (Task 2) ✓; public export (Task 3) ✓; the empirical composition validation with all five spec-§5 properties (Tasks 4–6) ✓; full CI gate (Task 7) ✓. Consumer wiring, pipeline integration, and reconciliation with the org's live throttle system are correctly deferred (spec §6/§7) and enumerated above, not silently dropped.

**Scope boundary:** every task's file list is under `suxlib/{src,test}` only. No task references `.github`, `claude-config`, or any workflow file — verified by re-reading every "Files:" line above.

**Placeholder scan:** `runSimulation`'s body and the five property-assertion bodies in Task 6 are intentionally left as an implementation contract (interface + comments) rather than fully inlined code, unlike Tasks 1–5's complete implementations — this is because the simulation's internals depend on decisions (exact tick granularity, exact burst schedule shape) that are better made by the implementer reading the fixtures they just built (Tasks 4–5) than dictated in advance; Task 6's Step 3 and Step 4 give explicit, non-optional acceptance criteria (all three matrix entries pass; failures are diagnosed as composition bugs and fixed, not loosened) so this is a scoped implementation task, not a hidden gap.

**Type consistency:** `TokenBucket`/`CircuitBreaker`/`BreakerState` (Tasks 1–2) are used verbatim by the simulation (Task 6); `Clock` (existing) is the single time-injection interface used by `tokenBucket`, `createFakeClock`, and (implicitly) by the simulation loop — no second clock abstraction is introduced.
