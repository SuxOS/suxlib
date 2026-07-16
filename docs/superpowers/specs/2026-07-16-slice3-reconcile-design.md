# Slice 3 — `reconcile` Conflict Modes (Design Spec)

**Date:** 2026-07-16
**Scope:** Slice 3 of the SuxOS v2 op-engine redesign — `reconcile` conflict-resolution modes beyond faithful-union.
**Status:** Draft for review. Terminal state of a research + design pass; next step is `writing-plans` (superseded here by the companion plan, since this pass produces spec+plan together) → `executing-plans`.
**Relates to:** `sux/docs/superpowers/specs/2026-07-15-suxos-v2-op-engine-design.md` (the parent spec — see its §1.3 non-goals and §7 risk `[S] reconcile beyond faithful-union (slice 3)`), `sux/docs/superpowers/plans/2026-07-15-suxos-v2-op-engine-walking-skeleton.md` (the Slice 1–2 plan whose Task 7 shipped `faithfulUnion` as the MVP), and `suxlib/src/op/reconcile.ts` (the code this spec extends).

---

## 0. One-paragraph summary

The Slice 1–2 walking skeleton shipped `reconcile` as faithful-union only — concat + dedup-by-identical-sha256, no conflict resolution — explicitly deferring richer modes to "slice 3, its own spec → plan → build" pending a research spike on the parent spec's flagged open question: is Splink/dedupe entity resolution (ER) evidence strong enough to build on? It is not — new evidence (below) is actively negative, not merely thin, and Splink is architecturally incompatible with `suxlib`'s Cloudflare Workers target regardless of accuracy. This spec instead ships two conflict modes with strong grounding and no exotic dependencies — `last-write-wins` (whole-record selection via the injected `Clock` capability, preserving durable-replay determinism) and `field-merge` (per-field structured merge over JSON-shaped handles) — and formally re-defers entity resolution, with the reasoning recorded so the question doesn't silently resurface unaddressed.

---

## 1. Goals, non-goals

### 1.1 Goals

1. Add **`last-write-wins`** as a `reconcile` mode: given N `Handle`s each stamped with a `producedAt` timestamp sourced from the injected `Clock` capability (never `Date.now()` — durable-replay determinism, per the parent spec's DBOS rule), select the handle with the latest `producedAt`; deterministic, documented tie-break on equal timestamps.
2. Add **`field-merge`** as a `reconcile` mode: given N `Handle`s of JSON-shaped content, merge field-by-field with a default policy (later handle's non-undefined fields win) and per-field overrides (`'last-write-wins' | 'union' | 'keep-first'`).
3. Refactor the `Op` reconcile node and `reconcile()` combinator from a flat `{mode: 'faithful-union'}` to a discriminated `ReconcileOpts` union, so adding future modes doesn't require another breaking shape change — **without changing `faithfulUnion`'s behavior or its existing test**.
4. Wire both new modes into `runInline`'s `reconcile` case (the only runtime that exists in `suxlib` today — `runDurable`/`interpretDurable` lives in the `sux` repo and is out of scope here per the task's repo boundary).
5. Record a grounded, evidence-based answer to the parent spec's open question on Splink/ER, so slice-3-proper (a future ER pass, if ever justified) starts from settled research instead of re-asking it.
6. Give a short, evidence-checked recommendation on the MCP `search_tools` item: does "defer, lean on Tool Search Tool" still hold?

### 1.2 Non-goals (this pass)

- **Entity resolution / dedupe (Splink or any alternative).** Deferred again — see §2 for why this is a *stronger* deferral than the parent spec's, not a repeat of the same open question.
- **`runDurable` / `interpretDurable` wiring in `sux`.** That repo is out of scope for this pass (task boundary); the new modes are designed to be replay-deterministic (leaf-sourced timestamps via `Clock`, no hidden I/O) precisely so a future `sux`-side wiring pass is mechanical, but doing that wiring is not this pass's job.
- **A general-purpose CRDT / merge-conflict framework.** `field-merge` is a pragmatic, single-level-JSON, policy-driven merge — not a full CRDT (no vector clocks, no causal history, no nested-conflict metadata). Sufficient for the op-engine's join step; a real CRDT is a different, much larger project not motivated by any current caller.
- **Building a custom MCP `search_tools` surface.** Confirmed still correctly deferred — see §2.4.

---

## 2. Research grounding (verified; cited; confidence-tagged)

Confidence tags follow the parent spec's convention: **[V]** harness-verified/primary-doc, **[I]** reasoned inference, **[S]** validate with a build-time spike.

### 2.1 Splink efficacy — the parent spec's flagged open question, now resolved

The parent spec's §7 risk was: *"reconcile beyond faithful-union (slice 3) — Splink/dedupe ER + conflict modes are medium-confidence (single-preprint efficacy); spike on real data before committing modes."* This pass did the research the parent spec called for, and found two independent, compounding blockers:

- **[V] Runtime incompatibility — a hard blocker independent of accuracy.** Splink is a Python library ("the Python library itself is essential for defining and controlling the linking operations") that generates SQL executed against a backend the caller chooses — DuckDB, Spark, PostgreSQL, or Athena — all of which require a Python process and, for the Spark backend, a JVM ([Splink backends docs](https://moj-analytical-services.github.io/splink/topic_guides/splink_fundamentals/backends/backends.html), [PyPI](https://pypi.org/project/splink/)). `suxlib` targets Cloudflare Workers (a V8 isolate — no Python runtime, no native binaries, no JVM). There is no officially supported way to run Splink itself inside this target; it would need a full from-scratch TypeScript reimplementation of the Fellegi-Sunter EM-training pipeline, which is a different (and far larger) project than "add a reconcile mode."
- **[V] Accuracy — no longer merely thin, now actively negative.** An independent 2025 benchmark paper, *"A Robust and Efficient Pipeline for Enterprise-Level Large-Scale Entity Resolution"* ([arXiv:2508.03767](https://arxiv.org/html/2508.03767v1)), evaluated Splink against two alternatives (MERAI, Dedupe) and found "significant accuracy deficiencies that render Splink unsuitable for high-precision enterprise applications." Concretely: **60.0–76.5% precision on deduplication tasks** (vs. 85.7–98.4% recall — i.e., Splink over-matches, a real cost in a system where a false merge silently discards a source record), and the paper's authors **explicitly excluded Splink from their scalability testing** because "its matching accuracy was significantly lower than both MERAI and Dedupe," with F1 trailing by 10–15 points across experiments. This is a downgrade from "single-preprint, medium-confidence" to "the one concrete third-party evaluation found is negative."
- **[I] The one "edge-safe TypeScript" alternative found does not clear the bar for adoption.** A search for a JS/WASM-native ER library surfaced `goldenmatch` (GitHub, single unverified author, no independent citations, marketing-style claims of beating "hand-tuned Splink" and a "verified 100M-row dedupe in 9.2 min" with no visible benchmark methodology or third-party reproduction). This is exactly the profile of an unverified claim that should not be load-bearing for a design decision — noted for completeness, explicitly **not** recommended.

**Conclusion: entity resolution / dedupe (Splink or otherwise) is deferred again**, on stronger grounds than the parent spec's original deferral. Recommend not spending further spike time on Splink specifically; if entity resolution is ever revisited, the honest starting point is "build or vendor a WASM-safe implementation and benchmark it ourselves," not "adopt Splink."

### 2.2 `last-write-wins` — grounding

- **[V] LWW is a standard, well-understood pattern** (Cassandra, Riak, GFS) — "the write with the latest timestamp wins" ([oneuptime.com/blog/post/2026-01-30-last-write-wins](https://oneuptime.com/blog/post/2026-01-30-last-write-wins/view), [Riak conflict resolution docs](https://docs.riak.com/riak/kv/latest/developing/usage/conflict-resolution/index.html)).
- **[V] The documented failure mode is clock-skew-driven data loss**, not algorithmic complexity: "When timestamps come from physical clocks on different nodes, LWW silently discards data from the node with the slower clock, even if that write happened later in real time" ([numberanalytics.com/blog/last-writer-wins-distributed-systems](https://www.numberanalytics.com/blog/last-writer-wins-distributed-systems)). Best practice: source timestamps from a single controlled clock where possible, and make ties deterministic rather than order-dependent-by-accident.
- **[I] This maps directly onto an existing `suxlib` constraint, not a new one.** The parent spec's DBOS determinism rule already forbids `Date.now()`/`Math.random()` inside anything that must replay durably (§3.5, parent spec). `last-write-wins` sourcing its timestamp from the injected `Clock` capability (`caps.clock.now()`) rather than the host clock is therefore not an extra design choice bolted on for this feature — it is the *only* implementation that doesn't reintroduce a determinism violation the walking skeleton already spent effort avoiding. This also sidesteps the clock-skew failure mode above: in `runInline`, `Clock` is one process's clock (no skew); in a future `runDurable` wiring, `Clock` would need to be sourced from workflow-instance-local state for the same reason `map`'s item list must come from a memoized step return (parent plan, Task 12 note) — flagged in §7, not solved here (out of scope: no `runDurable` in this repo).

### 2.3 `field-merge` — grounding

- **[I] No exotic dependency or unresolved research question here** — this is a deterministic code pattern (closest prior art: [RFC 7396, JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396)), not a statistical/ML claim requiring efficacy evidence. The design is intentionally conservative: single-level field policy, no recursive CRDT semantics, no hidden state.

### 2.4 MCP `search_tools` — does the parent spec's deferral still hold?

- **[V] Yes — confirmed, still correct, arguably more true now than in the parent spec.** Anthropic's Tool Search Tool (client-side `defer_loading`) is live and measured: "With 50+ MCP tools, the traditional approach consumes ~77K tokens before any work begins, while with Tool Search it's ~8.7K tokens... an 85% reduction," and tool-selection accuracy improved materially on Opus (49%→74% on one measured configuration; 79.5%→88.1% on Opus 4.5) ([platform.claude.com/docs/.../tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [MarkTechPost, 2026-05-29](https://www.marktechpost.com/2026/05/29/hermes-agent-ships-tool-search-for-mcp-anthropic-evals-show-49-to-74-accuracy-gain-on-opus-4/)).
- **[V-caveat] Still in public beta** — requires the `advanced-tool-use-2025-11-20` header, and is supported on Sonnet 4.5+/Opus 4.5+ only (no Haiku). Not a blocker for continuing to defer a custom build, but worth re-checking GA status before anything in `sux`/`suxlib` takes a hard dependency on it being universally available.
- **Recommendation: no change.** Keep leaning on the client-side Tool Search Tool; `sux()` + `fn`'s existing server-side progressive disclosure remains the right complement. Nothing in this research pass surfaced a reason to build a bespoke `search_tools` surface now. Re-verify beta→GA status opportunistically (e.g., next time `sux`'s MCP surface is touched), not as a scheduled follow-up — low stakes, no new information expected to change the call before then.

---

## 3. Architecture

### 3.1 Where this lands in the existing tree

```
suxlib/src/op/
  types.ts        # Op union — 'reconcile' node gains a nested `opts: ReconcileOpts` (was flat `mode`)
  combinators.ts   # reconcile() combinator signature widens to accept ReconcileOpts
  reconcile.ts     # gains lastWriteWins(), fieldMerge(), and a runReconcile() dispatcher;
                    # faithfulUnion() body is UNCHANGED
suxlib/src/handles/
  handle.ts        # Handle gains an optional `producedAt?: number`; new stamp() helper
suxlib/src/runtime/
  inline.ts        # 'reconcile' case delegates to runReconcile(node.opts, input, caps)
```

No new top-level directories, no new dependencies (`package.json` `dependencies` stays `{ fflate }`).

### 3.2 Type changes

```ts
// handles/handle.ts — Handle widens (additive, optional field — no existing call site breaks)
export interface Handle { r2Key: string; sha256: string; type: string; size: number; producedAt?: number }
export const stamp = (h: Handle, clock: Clock): Handle => ({ ...h, producedAt: clock.now() })

// op/reconcile.ts — new discriminated options type
export type FieldPolicy = 'last-write-wins' | 'union' | 'keep-first'
export type ReconcileOpts =
  | { mode: 'faithful-union' }
  | { mode: 'last-write-wins' }
  | { mode: 'field-merge'; defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy> }

// op/types.ts — Op's reconcile node: `mode: 'faithful-union'` -> `opts: ReconcileOpts`
export type Op =
  | { tag: 'leaf'; ... }
  | { tag: 'pipe'; ... }
  | { tag: 'map'; ... }
  | { tag: 'reconcile'; opts: ReconcileOpts }   // was: { tag: 'reconcile'; mode: 'faithful-union' }
  | { tag: 'sink'; ... }
  | { tag: 'ask'; ... }

// op/combinators.ts — call sites are unaffected: reconcile({ mode: 'faithful-union' }) still works
export const reconcile = (opts: ReconcileOpts): Op => ({ tag: 'reconcile', opts })
```

This is a safe widen: nothing outside `suxlib` consumes the `Op` reconcile shape yet (`runDurable`/`interpretDurable`, the only other consumer sketched in the parent plan, is unbuilt — it lives in `sux`, out of scope, and Task 12 there has not been started per this repo's own history). The existing `reconcile({ mode: 'faithful-union' })` call sites in `test/op/reconcile.test.ts` need no changes to their own code, only to `combinators.ts`'s internal wiring (`{tag:'reconcile', opts}` instead of `{tag:'reconcile', mode}`).

### 3.3 `lastWriteWins`

```ts
export function lastWriteWins(handles: Handle[]): Handle {
  if (handles.length === 0) throw new Error('lastWriteWins: empty input')
  const unstamped = handles.find(h => h.producedAt === undefined)
  if (unstamped) throw new Error(`lastWriteWins: handle ${unstamped.r2Key} has no producedAt — stamp it via stamp(handle, caps.clock) before reconciling`)
  return handles.reduce((winner, h) => (h.producedAt! >= winner.producedAt! ? h : winner))
}
```

**Design decisions (recorded, not left implicit):**
- **Fails loudly on unstamped input** rather than silently defaulting missing timestamps to `-Infinity`. A silent default would make "last element in array order wins whenever nobody bothered to stamp" an invisible, easy-to-hit footgun; a thrown error surfaces the mistake at the call site instead of at reconciliation time weeks later.
- **Tie-break: on equal `producedAt`, the later element in array order wins** (`>=` in the reduce). Deterministic and documented — directly addresses the "make ties deterministic, not order-dependent-by-accident" best practice from §2.2.
- **Returns the winning `Handle` unmodified** (no new `store.put`) — the losing handles' content was already write-once/content-addressed; there is nothing to merge, only to select. This also means `lastWriteWins` needs no `Store` capability at all, unlike `faithfulUnion`/`fieldMerge`.
- **Producers opt in by calling `stamp()`.** This is deliberately not automatic (e.g. not baked into `putBytes`/`putText`) — most callers of `put*` don't want or need a timestamp, and `Clock` is a capability that must be threaded from `Caps`, not ambient.

### 3.4 `fieldMerge`

```ts
export async function fieldMerge(handles: Handle[], store: Store, opts: { defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy> } = {}): Promise<Handle> {
  if (handles.length === 0) throw new Error('fieldMerge: empty input')
  const defaultPolicy = opts.defaultPolicy ?? 'last-write-wins'
  const docs = await Promise.all(handles.map(async h => JSON.parse(await resolveText(store, h)) as Record<string, unknown>))
  const merged: Record<string, unknown> = {}
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc)) {
      const policy = opts.policy?.[k] ?? defaultPolicy
      if (policy === 'keep-first') { if (!(k in merged)) merged[k] = v; continue }
      if (policy === 'union' && Array.isArray(v)) {
        const prior = Array.isArray(merged[k]) ? merged[k] as unknown[] : []
        merged[k] = [...new Set([...prior, ...v])]
        continue
      }
      merged[k] = v   // 'last-write-wins' (default): later handle's value overwrites
    }
  }
  return putText(store, JSON.stringify(merged), 'application/json')
}
```

**Design decisions:**
- **Single-level merge, by design** (non-goal §1.2) — nested objects are replaced wholesale by the winning policy, not recursively merged. Recursing correctly requires deciding a policy *per nested path*, which is unbounded complexity for a feature with no current caller demanding it; ship the flat version, widen only when a real op needs nested merge.
- **`'union'` policy requires an array value** — applying it to a non-array field is treated as a caller error (silently falls through to plain overwrite in the MVP; flagged in §7 as a spot to harden if this mode sees real use, not blocking for the first ship since no current caller passes non-array fields under `'union'`).
- **Default policy is `'last-write-wins'` at the field level** (later handle's key wins), mirroring the whole-record mode's name for a consistent mental model, but note this is *array-order* LWW (no `Clock` involved) — field-merge does not require every input to be independently timestamped. Callers who need per-field recency should timestamp their own documents and pass a `policy` that reflects it; `suxlib` does not invent a field-level clock-comparison scheme in this pass (no caller need identified — see §7).
- **Output type is `application/json`**, distinct from `faithfulUnion`'s `text/markdown` output — `field-merge` is documented as operating on JSON-shaped handles only (parent spec's own phrase); feeding it non-JSON content throws from `JSON.parse`, which is the correct failure (loud, immediate, at the point of misuse).

### 3.5 Dispatcher + `runInline` wiring

```ts
// op/reconcile.ts
export async function runReconcile(opts: ReconcileOpts, handles: Handle[], store: Store): Promise<Handle> {
  switch (opts.mode) {
    case 'faithful-union': return faithfulUnion(handles, store)
    case 'last-write-wins': return lastWriteWins(handles)
    case 'field-merge': return fieldMerge(handles, store, opts)
  }
}

// runtime/inline.ts — only this one line changes
case 'reconcile': return runReconcile(node.opts, input, caps.store)
```

`runDurable`/`interpretDurable` (in `sux`, unbuilt, out of scope) would wire identically — `runReconcile` takes no Workflow-specific arguments, so a future durable wiring pass is a one-line change (`step.do('reconcile', () => runReconcile(...))`) with no new design work, consistent with the parent spec's "promotion is free" goal (§3.1, parent spec) as long as timestamps keep flowing through `Clock`, never `Date.now()`.

---

## 4. Interfaces (the seams)

- **`suxlib` public API additions:** `stamp`, `lastWriteWins`, `fieldMerge`, `runReconcile`, `ReconcileOpts`, `FieldPolicy` exported from `src/index.ts` alongside the existing `reconcile.js`/`handle.js` re-exports.
- **Breaking-in-shape-but-not-in-call-site:** `Op`'s `{tag:'reconcile'}` node's field renames from `mode` to `opts`. No `suxlib` test or `sux`-side code (unbuilt) depends on the old shape directly — only through `reconcile()`, whose call signature is unchanged for the faithful-union case.
- **New precondition:** `lastWriteWins` requires every input `Handle` to carry `producedAt` (via `stamp()`), enforced with a thrown error, not a silent default.
- **New precondition:** `fieldMerge` requires every input `Handle`'s content to be valid JSON, enforced by `JSON.parse` throwing.

---

## 5. Testing

Same convention as the parent plan/spec: `suxlib`'s pure core is unit-tested, no mocks needed beyond the existing `MemoryStore` test double.

- `test/op/reconcile.test.ts` — existing `faithfulUnion` test, **unchanged**, must stay green through the `Op`/combinator refactor (regression guard for §3.2's "safe widen" claim).
- `test/op/reconcile-last-write-wins.test.ts` — new: (a) latest `producedAt` wins among 3 stamped handles in non-sorted array order; (b) equal-timestamp tie resolves to the later array element (documented determinism); (c) an unstamped handle in the input throws with a message naming the offending `r2Key`.
- `test/op/reconcile-field-merge.test.ts` — new: (a) later handle's field overwrites earlier handle's same-named field under the default policy; (b) a `'union'` policy on an array field de-duplicates and concatenates across handles; (c) a `'keep-first'` policy on a field preserves the earliest handle's value even though later handles also set it; (d) malformed (non-JSON) handle content throws.
- `test/handles/handle.test.ts` — extend with a `stamp()` case: stamping a handle with a fake `Clock` (`{now: () => 42}`) sets `producedAt` to `42` without mutating the original handle object (immutability check — `stamp` returns a new object, per §3.2's spread).
- `test/runtime/inline.test.ts` — extend (or add a sibling test) confirming `runInline` correctly dispatches a `reconcile({mode: 'last-write-wins'})` node end-to-end through the full tree (not just unit-testing `lastWriteWins` in isolation) — this is the integration point that would silently break if the `mode`→`opts` rename missed a call site.

No integration test against Cloudflare Workflows is needed or possible here — `runDurable` doesn't exist in this repo.

---

## 6. Rollout

- **This pass** — ship `last-write-wins` and `field-merge` reconcile modes in `suxlib`, refactor `Op`'s reconcile node to `ReconcileOpts`, re-confirm the MCP `search_tools` deferral. All in one PR against `suxlib`'s `main`.
- **Deferred, tracked, not silently dropped:**
  - Entity resolution / dedupe (Splink or an in-house alternative) — re-open only if a concrete caller need appears *and* a WASM-safe (or otherwise Workers-compatible) implementation exists to evaluate; the Splink-specific question is now closed (§2.1), not just paused.
  - Wiring these modes into `sux`'s `runDurable`/`interpretDurable` — that repo's own follow-on task, not blocked by anything here (§3.5 shows the wiring is mechanical once written).
  - Recursive/nested `field-merge` and array-level policies beyond `'union'`/`'keep-first'` — widen only when a real caller needs it (§3.4).

---

## 7. Risks & open questions (doubt)

- **[S] `Clock` sourcing under `runDurable`.** This pass only wires `last-write-wins` into `runInline`, where `Clock` is one process's clock with no skew. A future durable wiring needs `Clock` to be workflow-instance-local and replay-safe (same constraint the parent plan's Task 12 already documents for `map`'s item list) — not solved here, flagged for whoever picks up the `sux`-side wiring.
- **[I] `fieldMerge`'s `'union'` policy on a non-array field is unvalidated** — currently falls through to plain overwrite rather than throwing. Low risk (no current caller), but a rough edge; harden with an explicit type-check-and-throw if this mode gets a second caller.
- **[V] Entity resolution stays closed, not just paused.** Recorded here so a future contributor doesn't need to re-run the same research: Splink is both runtime-incompatible with Cloudflare Workers (Python/DuckDB/Spark/JVM — no Workers-compatible execution path) and, per independent third-party benchmarking, has weaker measured accuracy than at least two alternatives it was compared against. Revisiting ER should start from "what would we build or vendor that's Workers-compatible," not from Splink.
- **Time-sensitivity [V-caveat].** The MCP Tool Search Tool is in public beta as of this research pass (2026-07-16) — re-verify GA status before any `sux`-side surface takes a hard dependency on its availability.

---

## 8. What this explicitly is not

Not entity resolution / dedupe (closed, not deferred-with-hope — see §2.1, §7). Not a CRDT. Not the `sux`-side durable wiring (`runDurable`/`interpretDurable`), the MCP surface refactor, the vault redesign, the egress migration, or the governor — those remain out of scope exactly as the parent spec's §8 says, and this pass adds nothing to that list except closing the Splink question definitively.
