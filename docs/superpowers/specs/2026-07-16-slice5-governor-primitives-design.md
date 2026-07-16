# SuxOS v2 Op-Engine — Slice 5: Governor Primitives (Design Spec)

**Date:** 2026-07-16
**Scope:** Slice 5 of the SuxOS v2 redesign, narrowed to the **`suxlib` library primitives only** — see §1.3.
**Status:** Draft for review. Terminal state of a scoped `/brainstorming`-equivalent pass; next step is `writing-plans` (companion plan in this same commit).
**Relates to:** `sux/docs/superpowers/specs/2026-07-15-suxos-v2-op-engine-design.md` (the parent spec — §1.3 defers "the control-law composition (budget governor)" and "the autonomous pipeline de-shelling & PID/AIMD governor" to slice 5; §3.5 lists the intended primitives; §7 risk `[S] Control-law composition (slice 5)`). This spec fulfils the **library half** of that deferral. `suxlib/src/control/aimd.ts` (concurrency limiter) and `suxlib/src/control/retry.ts` (Full-Jitter backoff, idempotency key) already exist from slice 1 and are unchanged here — this spec adds the two missing primitives (token-bucket, circuit-breaker) and validates the four-primitive composition empirically.

---

## 0. One-paragraph summary

Slice 1 shipped three of the four control primitives the parent spec named for the eventual budget governor — AIMD (concurrency), Full-Jitter backoff (retries), idempotency keys — but deferred **token-bucket** (spend pacing) and **circuit-breaker** (fail-fast on a downed dependency) as slice-5 work, alongside the *composition* question the parent spec flagged as literature-empty. This spec closes both gaps **inside `suxlib` only**: it designs `tokenBucket()` and `circuitBreaker()` as pure, dependency-light primitives matching the existing `control/*` shape, and it re-runs the research pass the parent spec called for on AIMD-vs-PID-vs-token-bucket — with a materially stronger result this time (§2). It then specifies an empirical validation harness (deterministic simulation + property tests, entirely within `suxlib`, no live system) that exercises token-bucket + AIMD + Full-Jitter together under synthetic bursty/throttled traffic and asserts the properties a budget governor needs: bounded spend rate, no unbounded queue growth, recovery after a rate-limit storm, and graceful degradation when a downstream is circuit-broken. **What this spec explicitly does not do** is wire any of this into the autonomous pipeline, and it does not touch the org's existing live "budget governor" (throttle issues + check-throttle) system — both are called out in §1.3 and §7 as reconciliation work for a separate, human-reviewed initiative.

---

## 1. Goals, non-goals, and scope boundary

### 1.1 What "budget governor" means in this spec

The parent spec (§3.5, §7) names a **budget governor** as the eventual composition of: **token-bucket** (paces the rate of spend — e.g. tokens/dollars/requests per unit time), **AIMD** (discovers and adapts the sustainable *concurrency* against a live dependency), **Full-Jitter backoff** (paces *retries* of an individual failed call), and **circuit-breaker** (stops sending load entirely once a dependency is provably down, rather than continuing to pace failed calls). These are four **orthogonal control loops** — rate, concurrency, retry-spacing, and availability — not four implementations of the same idea; §2 grounds why they compose rather than compete.

### 1.2 Goals (this spec)

1. **`tokenBucket()`** in `suxlib/src/control/token-bucket.ts` — a pure, clock-injected rate limiter matching the `Concurrency`-adjacent shape already established by `aimd()`/`fixed()` in `control/aimd.ts` (same file-per-primitive convention, same capability-injection discipline as the rest of `suxlib`).
2. **`circuitBreaker()`** in `suxlib/src/control/circuit-breaker.ts` — a pure, clock-injected three-state (closed/open/half-open) breaker, canonical shape (§2), usable by any leaf's effect wrapper.
3. **Empirical validation of the composition** — a deterministic simulation harness (`test/control/governor-simulation.test.ts` + a small synthetic-traffic generator) that runs token-bucket + AIMD + Full-Jitter + circuit-breaker together against a fake unreliable dependency and asserts the budget-governor properties in §5, replacing the parent spec's `[S]` "validate empirically" risk note with either evidence or a documented counter-finding.
4. **Public surface** — export both new primitives from `suxlib/src/index.ts` alongside the existing `control/*` exports, so any future op leaf (in `suxlib` or in a consuming Worker) can wrap an effect leaf with `{ tokenBucket, circuitBreaker }` the same way `map()` already wraps with `{ concurrency: aimd() }`.
5. **Reconciliation note, not integration** — document (§7) that this org already runs a separate, live "budget governor" (throttle issues + check-throttle mechanics, unrelated to this repo, per user memory) and that any *future* work wiring these `suxlib` primitives into a running pipeline must reconcile with — not duplicate — that system. This spec does not locate, read, or describe that system's implementation; it only flags the seam.

### 1.3 Non-goals — hard scope boundary

This pass is **`suxlib`-library-only**. Explicitly out of scope, not touched, not read, not planned in the companion implementation plan:

- **The autonomous pipeline de-shelling.** No file in `/Users/colinxs/Code/SuxOS/.github` or `/Users/colinxs/Code/SuxOS/claude-config`, and no GitHub Actions workflow in any repo, is read or modified by this spec or its plan. `.github`'s own `CLAUDE.md` documents that its workflows are shared by every repo's CI/automerge/backlog pipeline — wiring a new governor into that surface is a separate, much-higher-blast-radius change needing a dedicated human-reviewed initiative, not a parallel batch pass riding on this one. **Anyone executing the companion plan must not touch these paths; if a build step finds itself editing anything under `.github/` or `claude-config/`, it has drifted out of scope and should stop.**
  This is the exact instruction under which this spec was authored and is restated here so it survives into the implementation plan and any build agent that picks it up later.
- **The org's existing live budget-governor system** (throttle issues + check-throttle). Not located, not read, not modified. §7 flags the reconciliation need for later; this spec does not speculate about that system's internals.
  the org's existing live "budget governor" (throttle issues + check-throttle) is a *cadence/frequency* governor over autonomous-pipeline runs, using GitHub issues as its control-plane state — a different mechanism operating at a different layer than the *spend/concurrency* governor this spec designs as library primitives. They are namesakes, not the same system, which is precisely why reconciliation (not duplication) is called out rather than assumed-irrelevant.
- **Slice 3's `reconcile` conflict modes**, **slice 4's vault semantic search**, and **slice 2's `runDurable`/tracer-bullet follow-through** — untouched, unrelated to this slice.
- **Wiring the governor into any op leaf, the `sux` Worker, or any live traffic.** This spec produces library primitives and a simulation-based validation; it does not produce a consumer. That is deliberately deferred — see §6 rollout and §8.
- **A live-traffic or production validation.** §2/§5's empirical work is simulation and property-based testing *inside `suxlib`*, run in `vitest`, with a synthetic fake dependency. Nothing here calls a real external API, spends real budget, or touches a real queue.

---

## 2. Research grounding (verified; cited; confidence-tagged)

The parent spec's §2/§7 ran two adversarial deep-research passes and came back with **zero verifiable claims** on AIMD-vs-PID-vs-token-bucket *as a composed budget governor*, tagging it `[S]` — an engineering judgment call, not a literature finding. This section re-runs that research with a narrower, more answerable framing: instead of asking "is there a paper about this exact four-primitive composition" (there still isn't — see below), it asks the four sub-questions that actually determine whether the composition is sound. Confidence tags match the parent spec's scheme: **[V]** harness-verified/primary-doc, **[I]** reasoned inference, **[S]** validate with a build-time spike.

- **[V] AIMD's convergence property is a proven theorem, not a heuristic.** Chiu & Jain's 1989 analysis (*"Analysis of the Increase and Decrease Algorithms for Congestion Avoidance in Computer Networks"*) proves that additive-increase/multiplicative-decrease is the **necessary and sufficient** linear control law for distributed convergence to an efficient *and* fair allocation from any starting state, under a binary (congested/not-congested) feedback signal — multiplicative decrease "releases" unfairly-held resources while additive increase reallocates fairly, and *any* other combination of linear increase/decrease policies fails to converge to fairness without global coordination. This is materially stronger grounding than the parent spec's citation (which only established AIMD as "the field standard" via Netflix/gadget-inc/floodgate precedent) — it establishes AIMD as **provably the right shape of control law** for a binary success/failure signal, which is exactly the signal shape a `429`/`5xx` response gives a concurrency limiter. ([Chiu & Jain summary — UC Berkeley](https://people.eecs.berkeley.edu/~fox/summaries/networks/chiu_jain.html), [full analysis reprints](https://mural.maynoothuniversity.ie/1771/1/HamiltonFairnessConvergence.pdf))
- **[V] PID's rejection now has a specific, citable failure mode, not just "integral-windup risk."** Classical-control literature documents **integral windup / reset windup** as a well-characterized failure mode: when the controller's output saturates against an actuator limit (exactly what happens when a rate limiter is already at its floor or ceiling), the integral term keeps accumulating unbounded error because the actuator can't act on it, and when the saturation lifts the controller overshoots and oscillates — this is *why* production PID controllers require dedicated anti-windup compensation (back-calculation or clamping) as a separate, hand-tuned mechanism, not an incidental detail. A rate/concurrency governor's "actuator" (the send rate) saturates constantly by design — it's *supposed* to hit its ceiling under healthy load and its floor under an outage — which is precisely the operating regime where PID's failure mode bites hardest. Network-congestion-control papers that do use PID (WSN queue control, high-speed-network congestion) confirm PID *can* be made to work in this domain, but only with explicit anti-windup design and per-environment gain tuning that AIMD's parameter-light convergence proof doesn't require. **This upgrades the parent spec's rejection from an unsupported risk note to a literature-grounded engineering tradeoff**: PID is not impossible here, but it trades AIMD's near-parameter-free provable convergence for a tuning/anti-windup burden with no offsetting benefit for a binary discrete signal. ([Integral windup — Grokipedia](https://grokipedia.com/page/Integral_windup), [Integral (Reset) Windup — Control Guru](https://controlguru.com/integral-reset-windup-jacketing-logic-and-the-velocity-pi-form/), [PID congestion control, high-speed networks — IEEE](https://ieeexplore.ieee.org/document/7086602/), [PID congestion control, WSN — IEEE](https://ieeexplore.ieee.org/document/6858963/))
- **[I] Token-bucket-for-spend and AIMD-for-concurrency is convergent current industry practice, specifically for LLM cost governance** — not just general rate limiting. 2026 LLM-gateway literature (agentgateway, Solo's agentgateway docs, independent cost-governance write-ups) converges on the same layering this spec proposes: a **token-bucket admission check** gating spend/token consumption before a call is allowed, with **concurrency/queueing controls as a separate, orthogonal layer** — "cost control is implemented as layered defenses: admission (budget check) → concurrency cap → ...". This is industry-practice inference (**[I]**, not a proof), but it directly answers the parent spec's open question in the affirmative: practitioners already treat "pace the spend" and "pace the concurrency" as two different control loops that should compose rather than merge into one controller, which is the structural argument for this spec's composition. ([Budget and spend limits — agentgateway](https://agentgateway.dev/docs/kubernetes/main/llm/budget-limits/), [LLM cost governance — Matheus Palma](https://matheuspalma.com/blog/llm-cost-governance-token-budgets-model-routing-spend-guardrails))
- **[V] Circuit-breaker is a distinct, canonical, third control loop — not a variant of rate limiting.** Nygard's *Release It!* (2007) originated the pattern; Netflix's Hystrix made the three-state (closed → open → half-open) machine the industry-standard shape: closed passes traffic and counts failures, open fails fast without attempting the call at all (the property token-bucket/AIMD don't have — they still *attempt* calls, just paced), half-open after a cooldown lets a bounded trickle through to test recovery before fully reopening. This is the primitive that answers "the dependency is provably down" where token-bucket/AIMD only answer "the dependency is provably *slow* or *rejecting*" — a real orthogonality, not overlap. ([Circuit Breaker — Nygard/Hystrix summary](https://medium.com/@seanlinsanity/circuit-breaker-pattern-in-spring-cloud-netflix-hystrix-7629c14f2114), [Hystrix wiki — how it works](https://github.com/netflix/hystrix/wiki/how-it-works))
- **[I] A refinement worth flagging but explicitly not adopting here: gradient-based concurrency control.** Netflix's `concurrency-limits` and Envoy's Adaptive Concurrency filter implement a *variant* of AIMD that uses a continuous latency-gradient signal (measured RTT vs. a periodically-remeasured minimum RTT) instead of AIMD's binary success/failure signal, adjusting the limit proportionally to how degraded the gradient is rather than by a fixed halving. This is strictly more sophisticated than the classic AIMD already in `suxlib/src/control/aimd.ts` and could be a future refinement, but it requires a latency-measurement capability the current `Concurrency` interface doesn't carry and Chiu & Jain's convergence proof doesn't cover a continuous gradient signal — adopting it now would be scope creep and a second literature-grounding effort. **Decision: out of scope for slice 5; the existing binary-signal `aimd()` is retained as-is.** ([Envoy Adaptive Concurrency docs](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/adaptive_concurrency_filter.html), [Netflix Performance Under Load](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581))
- **[S] The specific four-primitive composition remains genuinely without prior art — confirmed, not just asserted.** A targeted search for "token bucket + circuit breaker + AIMD combined layered resilience pattern composition" returned individual-pattern documentation only; no source describes this specific four-primitive stack as a named, evaluated whole. This matches the parent spec's finding and is **not resolved by better search** — it's resolved by empirical validation, which is what §5's simulation harness is for. Confidence stays `[S]`: each primitive is now individually well-grounded (upgraded from the parent spec's blanket `[S]`), but the *composition as a system* is validated here by simulation, not literature, exactly as the parent spec's risk note prescribed.

**Net effect on the parent spec's `[S]` risk note (§7):** the position — token-bucket (spend) + AIMD (concurrency) + Full-Jitter (retries), PID rejected — is **unchanged**, but it is no longer a bare judgment call. Three of its four legs (AIMD's optimality, PID's failure mode, circuit-breaker's orthogonality) now have direct literature grounding `[V]`; the fourth (token-bucket for spend specifically) has current industry-practice grounding `[I]`; only the *composition as an evaluated whole* remains `[S]`, and that gap is closed empirically by §5, not asserted away.

---

## 3. Architecture — the two new primitives

### 3.1 `tokenBucket()` — `suxlib/src/control/token-bucket.ts`

A classic token bucket: capacity `C`, refill rate `r` tokens/ms, clock-injected (no `Date.now()`/`setTimeout` baked in — matches the `Clock` capability already defined in `suxlib/src/effects/types.ts` and used by `Caps`). Shape mirrors `Concurrency` (`op/types.ts`) closely enough to compose in a `map()`'s `concurrency` slot conceptually, but its own interface is intentionally distinct because it answers a different question (*may I spend N units now?*, not *may I hold a slot?*):

```ts
export interface TokenBucket {
  tryTake(cost: number, nowMs: number): boolean          // non-blocking: true iff cost tokens were available and consumed
  take(cost: number, clock: Clock): Promise<void>        // blocking: waits (via clock-driven backoff) until cost tokens are available
  readonly tokens: number                                 // current level, for testability/observability
}
export function tokenBucket(opts: { capacity: number; refillPerMs: number; clock: Clock }): TokenBucket
```

- **Pure w.r.t. time:** the bucket never reads the wall clock itself — every call that needs "now" takes it as an argument or via the injected `Clock`, matching the DBOS determinism rule the parent spec's §3.1 established for all of `suxlib` (needed so a leaf wrapped in this primitive stays promotable to a durable Workflow step without a hidden nondeterministic read).
- **Lazy refill, not a timer:** tokens are computed as `min(capacity, tokens + (now - lastRefillMs) * refillPerMs)` on each `tryTake`/`take` call — no background interval, no timer leak, consistent with the rest of `suxlib` having zero ambient I/O.
- **`take()`'s wait uses `backoffFullJitter()`** from the already-implemented `control/retry.ts` to space its poll attempts — this is the first concrete point of composition between the new primitive and the existing slice-1 code, not a new backoff implementation.

### 3.2 `circuitBreaker()` — `suxlib/src/control/circuit-breaker.ts`

Three-state machine per §2's canonical shape:

```ts
export type BreakerState = 'closed' | 'open' | 'half-open'
export interface CircuitBreaker {
  readonly state: BreakerState
  allow(nowMs: number): boolean                 // false in 'open' (before cooldown elapses); true otherwise
  onSuccess(nowMs: number): void                 // in half-open: enough successes -> closed; in closed: resets failure count
  onFailure(nowMs: number): void                 // in closed: failure count >= threshold -> open; in half-open: any failure -> open
}
export function circuitBreaker(opts: {
  failureThreshold: number       // consecutive failures in 'closed' before tripping to 'open'
  cooldownMs: number             // time in 'open' before probing via 'half-open'
  halfOpenSuccesses: number      // consecutive successes in 'half-open' before returning to 'closed'
}): CircuitBreaker
```

- **State transitions are the whole contract** — `closed --failureThreshold failures--> open --cooldownMs elapsed--> half-open --halfOpenSuccesses successes--> closed`, and `half-open --any failure--> open` (resets the cooldown). This mirrors Hystrix/Nygard exactly (§2); no novel state is introduced.
- **`allow()` is the integration point**: an effect leaf checks `allow()` before attempting a call, and reports the outcome via `onSuccess`/`onFailure`. It composes with `tokenBucket`/`aimd` as an outer gate — a caller checks the breaker first (is the dependency even up?), then the token bucket (is there spend budget?), then AIMD's `acquire()` (is there a concurrency slot?) — three independent gates, checked in that order because each is progressively more expensive to have wasted (an open breaker should reject before consuming a token or a concurrency slot).

### 3.3 The composition as a pattern (not new code)

Nothing in this slice introduces a fifth "governor" abstraction that wraps all four primitives into one object — the parent spec's `[S]` risk note asked for **validation of the composition**, not a new unifying API, and inventing one now would be exactly the kind of premature abstraction the parent spec's "keep the skeleton thin" principle warns against. The composition is instead **specified as a call-site pattern** (documented in `suxlib`'s exported types' doc-comments and demonstrated by the §5 simulation) that a future op leaf or Worker adapter follows:

```ts
if (!breaker.allow(now)) throw new NonRetryableError('circuit open')
if (breaker.state === 'half-open' && halfOpenProbeInFlight) throw new NonRetryableError('half-open probe already in flight')
await tokenBucket.take(estimatedCost, clock)
await concurrency.acquire()
try {
  const result = await effect()
  concurrency.release(true); breaker.onSuccess(now)
  return result
} catch (e) {
  concurrency.release(false); breaker.onFailure(now)
  throw e   // a wrapping Workflow step retry (or backoffFullJitter for a non-step caller) handles the retry itself — single retry point, per parent spec §3.5
}
```

This snippet is illustrative (belongs in the plan/tests, not shipped as an API) and deliberately does **not** wire itself into any op leaf, the `run()` verb, or a Worker — that consumer-side wiring is future work per §6/§8.

**Finding from §5's simulation, folded back in here per the plan's Task 6 acceptance criteria:** `circuitBreaker.allow()` alone does **not** cap the number of concurrent probes during `half-open` — every call reaching `allow()` while the breaker is in `half-open` returns `true`, regardless of how many other probes are already outstanding. If the call site doesn't add its own single-flight guard (the second line above, new versus the original draft of this snippet), a caller with an AIMD concurrency limit greater than 1 can let more than `halfOpenSuccesses` probes race through a single half-open window at once — which both over-counts successes toward closing the breaker relative to what was actually validated, and defeats half-open's purpose of trickling a *bounded* trial load at a possibly-still-recovering dependency. This is exactly the "known bug class, novel to the composition, anticipated but not yet located" risk §7 flagged in advance; the simulation surfaced it as soon as any matrix entry exercised a full open→half-open→closed cycle, and the fix belongs here, in the call-site pattern, not in `circuitBreaker` itself (`circuitBreaker`'s own state-machine contract, §3.2, is unchanged and still fully correct in isolation — this is a composition-level concern, same reasoning as the risk note anticipated).

---

## 4. Interfaces (the seams)

- **`suxlib` public API additions:** `tokenBucket`, `TokenBucket`, `circuitBreaker`, `CircuitBreaker`, `BreakerState` exported from `suxlib/src/index.ts` alongside the existing `control/*` surface (`aimd`, `fixed`, `backoffFullJitter`, `idempotencyKey`).
- **Consumes:** the existing `Clock` capability (`suxlib/src/effects/types.ts`) for `tokenBucket`; `backoffFullJitter` (`control/retry.ts`) for `take()`'s poll spacing. No new capability interfaces are introduced.
- **Depends on nothing ambient** — same isolation test as the rest of `suxlib` (parent spec §4): a reader of `token-bucket.ts` or `circuit-breaker.ts` alone can answer what it does / how to use it / what it depends on without reading the op engine, the runtime, or any Worker.
- **Not exposed:** no `run()`-level, op-combinator-level, or Worker-level integration. A future op leaf that wants a governed effect composes the primitives itself per §3.3's pattern; this slice does not add a `governedOp()` combinator.

---

## 5. Testing — empirical validation of the composition

This is the section that discharges the parent spec's `[S]` "validate empirically" instruction. All of it runs inside `suxlib`'s existing `vitest` setup; nothing here is a live system.

- **Unit tests, one per primitive** (the existing "1 test · 1 file · 1 fn" convention): `test/control/token-bucket.test.ts` (capacity cap, linear refill, `tryTake` vs `take` semantics, zero-cost edge case), `test/control/circuit-breaker.test.ts` (every state transition in §3.2's contract, including the half-open-fails-back-to-open case).
- **A synthetic unreliable dependency** — `test/control/fixtures/flaky-dependency.ts` — a deterministic, seeded fake that: rejects with `429` above a configured concurrent-request threshold (to exercise AIMD), goes fully down for a configured window (to exercise circuit-breaker), and enforces a token cost per call (to exercise token-bucket). Seeded, not `Math.random()`-driven, so failures are reproducible test-to-test.
- **`test/control/governor-simulation.test.ts`** — the composition test. Drives N synthetic calls (default: a burst pattern — quiet, then a spike, then a sustained overload, then recovery) through the §3.3 call-site pattern wired to the flaky dependency, using a fake `Clock` advanced by the test (no real timers, no test flakiness from real wall-clock races) — and asserts, as **properties**, not example-based single assertions:
  1. **Bounded spend rate:** total tokens consumed across any sliding window never exceeds `capacity + refillPerMs * windowMs` (the token bucket's own contract — proves the wrapper didn't bypass it).
  2. **No unbounded queue growth:** the number of calls waiting on `tokenBucket.take()` or `concurrency.acquire()` at any simulated instant stays bounded by a configured ceiling — a governor that queues without bound under sustained overload is a resource leak, not backpressure.
  3. **Recovery after a rate-limit storm:** after the synthetic dependency's overload window ends, AIMD's limit and the breaker's state both return to a healthy steady-state within a bounded number of simulated ticks — proves the composition doesn't get stuck in a degraded state once the underlying problem clears (a plausible failure mode if the breaker's cooldown and AIMD's ramp-up were tuned to fight each other).
  4. **Fail-fast during an outage:** while the synthetic dependency is in its "fully down" window, the fraction of calls that reach the flaky dependency (vs. being rejected locally by `breaker.allow() === false`) drops near zero within `cooldownMs` of the outage starting — proves the breaker is actually doing its job of *not* attempting calls, as distinct from AIMD/token-bucket merely slowing them down.
  5. **No livelock between the breaker's half-open probe and AIMD's ramp-up:** during the half-open recovery window, the number of probe calls allowed through matches `halfOpenSuccesses` (not more, not fewer) regardless of how AIMD's concurrency limit is currently set — proves the two controllers don't fight over how many calls get through during recovery.
- **Property-based, not just example-based:** each property above is checked across a small matrix of burst-pattern parameters (spike height, overload duration, token cost per call) generated deterministically (seeded), not a single hand-picked scenario — this is what "validate empirically" means operationally for a `suxlib`-internal simulation, short of a live-system spike.
- **Explicitly not covered here (and not owed by this slice):** a real network call, a real Cloudflare Workflow, or any interaction with the org's live throttle/check-throttle system. Those require the future, separately-scoped integration work flagged in §7.

---

## 6. Rollout

- **This slice** — `tokenBucket()`, `circuitBreaker()`, both fully unit-tested; the governor-simulation harness with the five properties in §5; both exported from `suxlib`'s public surface. No consumer wiring.
- **Deferred, tracked, not silently dropped** (mirrors the parent spec's own "Deferred to the follow-on plan" discipline):
  - Wiring `tokenBucket`/`circuitBreaker`/`aimd`/`backoffFullJitter` into an actual op leaf or the `run()` front-verb in the `sux` Worker — needs a real capability (what counts as "cost" for a given leaf? tokens? dollars? requests?) that this spec deliberately leaves abstract (`cost: number`, caller-defined units).
  - The gradient-based concurrency refinement flagged in §2 as a possible AIMD successor — explicitly not adopted this slice.
  - Any integration with the autonomous pipeline (`.github`, `claude-config`) — out of scope per §1.3, belongs to a dedicated human-reviewed initiative.
  - Reconciliation with the org's existing live throttle/check-throttle budget-governor system — flagged in §7, not investigated or designed here.

---

## 7. Risks & open questions (doubt)

- **[S→partially resolved] Control-law composition.** The parent spec's `[S]` risk is now backed by literature for three of its four legs (§2); the composition-as-a-system claim is validated by simulation (§5) rather than by finding prior art, because none exists for this specific four-primitive stack. Residual risk: a simulation, however property-based, is not a live-system proof — the parent spec's original "validate empirically" instruction is satisfied at the `suxlib`-internal level, but a future integration slice should re-validate against a real dependency's actual failure modes (real APIs rarely fail as cleanly as a seeded fake).
- **[Reconciliation, not conflict — flagged for future work] The org already runs a separate, live "budget governor."** Per the user's own memory of this org, there is an existing throttle-issue + check-throttle mechanism, unrelated to this repo, that governs autonomous-pipeline cadence. This spec's `tokenBucket`/`circuitBreaker`/`aimd` primitives are a different mechanism at a different layer (library-level spend/concurrency pacing for `suxlib` ops, vs. that system's pipeline-cadence governance) — but the naming collision ("budget governor") is real and deliberate confusion-bait for a future integrator. **Any future work that wires these `suxlib` primitives into a running pipeline must first read and reconcile with that existing system rather than standing up a second, competing governor.** This spec does not attempt that reconciliation — it was explicitly instructed not to locate or read that system's code, only to flag the seam, and does so here.
- **`cost` units are caller-defined and unvalidated.** `tokenBucket`'s `cost: number` is deliberately unopinionated (tokens? dollars? requests?) because no consumer exists yet to force a decision — a future integration slice will have to pick, and a wrong early choice (e.g. baking in "cost = 1 request" when the real need is "cost = LLM tokens spent") would need a breaking change. Documented here so it isn't rediscovered the hard way.
- **[Confirmed, fixed] Half-open concurrency during recovery is a known subtlety.** §5's property 5 (no livelock between breaker half-open and AIMD ramp-up) is the one place this spec anticipated a real bug class rather than a documented one — the interaction is novel to this composition. The simulation confirmed it: `circuitBreaker.allow()` alone does not cap concurrent half-open probes, so without a call-site-level single-flight guard, an AIMD limit greater than 1 lets more probes than `halfOpenSuccesses` race through a half-open window at once. Per this note's original prediction, the fix landed in the call-site pattern (§3.3, now updated with the guard), not in either primitive individually — `circuitBreaker` and `aimd` are both still correct and unchanged in isolation.

---

## 8. What this explicitly is not

Not the autonomous pipeline integration, not a wiring into any op leaf or the `sux` Worker's `run()` verb, not a reconciliation with the org's existing live budget-governor system, not a live-traffic validation, not a new unifying "governor" abstraction. This spec delivers exactly two new pure library primitives plus an empirical (simulation-based) answer to the parent spec's composition question — everything else is future work, explicitly enumerated in §6 and §7 so nothing is silently dropped.
