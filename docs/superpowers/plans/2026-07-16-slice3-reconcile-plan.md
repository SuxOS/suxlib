# Slice 3 — `reconcile` Conflict Modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `last-write-wins` and `field-merge` conflict-resolution modes to `suxlib`'s `reconcile`, refactor the `Op` reconcile node to a discriminated `ReconcileOpts` union without breaking the existing faithful-union call site or test, and wire both new modes into `runInline`.

**Architecture:** See the companion spec, `docs/superpowers/specs/2026-07-16-slice3-reconcile-design.md`, §3. Summary: `Handle` gains an optional `producedAt?: number` + a `stamp(handle, clock)` helper; `op/reconcile.ts` gains `lastWriteWins()`, `fieldMerge()`, and a `runReconcile(opts, handles, store)` dispatcher; `op/types.ts`'s reconcile node field renames `mode` → `opts: ReconcileOpts`; `runtime/inline.ts`'s `reconcile` case delegates to the new dispatcher.

**Tech Stack:** Same as the existing repo — TypeScript 5, `npm`, Vitest, no new dependencies.

## Global Constraints

- **No new dependencies.** `package.json`'s `dependencies` stays `{ fflate }`. Both new modes are pure TypeScript over the existing `Store`/`Clock` capability interfaces.
- **Entity resolution is out of scope for this plan.** Per the companion spec §2.1 and §8 — do not add Splink, `goldenmatch`, or any ER/dedupe library. If a task in this plan seems to be drifting toward ER, stop and re-read the spec.
- **Determinism:** `lastWriteWins`'s timestamp source is always `caps.clock.now()` via `stamp()`, never `Date.now()` — this is what keeps a future durable-replay wiring free (parent spec's DBOS rule).
- **Backward compatibility:** `test/op/reconcile.test.ts` (the existing `faithfulUnion` test) must pass, unmodified, after every task in this plan. If a task's diff would require editing that file, stop — the refactor has leaked further than intended.
- **Repo boundary:** every file touched in this plan lives under `suxlib/`. No commits to `sux`, `sux-fileops`, `.github`, or `claude-config`.

---

## File Structure

**Modified:**
- `src/handles/handle.ts` — add `producedAt?: number` to `Handle`; add `stamp()`
- `src/op/types.ts` — reconcile node: `mode: 'faithful-union'` → `opts: ReconcileOpts`
- `src/op/combinators.ts` — `reconcile()` signature widens to `(opts: ReconcileOpts) => Op`
- `src/op/reconcile.ts` — add `ReconcileOpts`, `FieldPolicy`, `lastWriteWins()`, `fieldMerge()`, `runReconcile()`; `faithfulUnion()` body unchanged
- `src/runtime/inline.ts` — `reconcile` case delegates to `runReconcile()`
- `src/index.ts` — re-export the new symbols (already covered by existing `export *` from `handles/handle.js` and `op/reconcile.js` — verify, don't assume)

**New:**
- `test/handles/handle.test.ts` — extend with a `stamp()` case (existing file, additive)
- `test/op/reconcile-last-write-wins.test.ts`
- `test/op/reconcile-field-merge.test.ts`
- `test/runtime/inline-reconcile-modes.test.ts` — integration check that `runInline` dispatches the new modes end-to-end

---

## Task 1: Refactor the `Op` reconcile node to `ReconcileOpts` (no behavior change)

**Files:**
- Modify: `src/op/reconcile.ts`, `src/op/types.ts`, `src/op/combinators.ts`, `src/runtime/inline.ts`

**Interfaces:**
- Produces: `ReconcileOpts = {mode:'faithful-union'} | {mode:'last-write-wins'} | {mode:'field-merge'; defaultPolicy?; policy?}` (the last two variants are declared now but their implementations land in Tasks 3–4; TypeScript will happily accept the type before the functions exist, since `runReconcile` isn't written to dispatch them yet).
- Changes the `Op` union's reconcile variant from `{tag:'reconcile'; mode:'faithful-union'}` to `{tag:'reconcile'; opts: ReconcileOpts}`.
- `reconcile()` combinator: `(opts: ReconcileOpts) => Op` (was `(o: {mode:'faithful-union'}) => Op`) — external call sites (`reconcile({mode:'faithful-union'})`) are unaffected.

This task is a pure refactor — no new runtime behavior, so its "failing test" is the *existing* test failing to compile/pass until the refactor is complete end-to-end, then passing again unmodified.

- [ ] **Step 1: Confirm the existing test currently passes (baseline)**
  Run: `npm test` — Expected: PASS (11 tests, including `test/op/reconcile.test.ts`). This is the regression guard for the whole task.

- [ ] **Step 2: Add `ReconcileOpts`/`FieldPolicy` types and widen the `Op` union**
  In `src/op/reconcile.ts`, above the existing `faithfulUnion`:
  ```ts
  export type FieldPolicy = 'last-write-wins' | 'union' | 'keep-first'
  export type ReconcileOpts =
    | { mode: 'faithful-union' }
    | { mode: 'last-write-wins' }
    | { mode: 'field-merge'; defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy> }
  ```
  In `src/op/types.ts`, change the reconcile variant:
  ```ts
  import type { ReconcileOpts } from './reconcile.js'
  export type Op =
    | { tag: 'leaf'; name: string; fn: LeafFn; opts: LeafOpts }
    | { tag: 'pipe'; steps: Op[] }
    | { tag: 'map'; op: Op; concurrency: Concurrency }
    | { tag: 'reconcile'; opts: ReconcileOpts }
    | { tag: 'sink'; targets: string[] }
    | { tag: 'ask'; prompt: string; timeout: string; onTimeout: 'proceed' | 'fail' }
  ```
  **Note the new cross-import:** `op/types.ts` now imports from `op/reconcile.ts`. Check `src/op/reconcile.ts`'s existing imports don't import anything from `op/types.ts` that would create a cycle — today it only imports from `../effects/types.js` and `../handles/handle.js`, so this is safe. If a future task adds an import from `op/types.ts` into `reconcile.ts`, break the cycle by moving `ReconcileOpts`/`FieldPolicy` into `op/types.ts` instead — call this out in review if it comes up, don't silently restructure.

- [ ] **Step 3: Update `reconcile()` in `src/op/combinators.ts`**
  ```ts
  import type { Op, LeafFn, LeafOpts, Concurrency } from './types.js'
  import type { ReconcileOpts } from './reconcile.js'
  export const reconcile = (opts: ReconcileOpts): Op => ({ tag: 'reconcile', opts })
  ```

- [ ] **Step 4: Update the `reconcile` case in `src/runtime/inline.ts`**
  ```ts
  import type { Op, Caps } from '../op/types.js'
  import { faithfulUnion } from '../op/reconcile.js'
  export async function runInline(node: Op, input: any, caps: Caps): Promise<any> {
    switch (node.tag) {
      case 'leaf': return node.fn(input, caps)
      case 'pipe': { let v = input; for (const s of node.steps) v = await runInline(s, v, caps); return v }
      case 'map': {
        const items: any[] = input; const out = new Array(items.length)
        await Promise.all(items.map(async (it, i) => {
          await node.concurrency.acquire()
          try { out[i] = await runInline(node.op, it, caps); node.concurrency.release(true) }
          catch (e) { node.concurrency.release(false); throw e }
        }))
        return out
      }
      case 'reconcile':
        if (node.opts.mode !== 'faithful-union') throw new Error(`reconcile mode not yet wired: ${node.opts.mode}`)
        return faithfulUnion(input, caps.store)
      case 'sink': { await Promise.all(node.targets.map(t => caps.sinks[t].write(input, caps))); return input }
      case 'ask': return input
    }
  }
  ```
  (The explicit throw for unwired modes is temporary scaffolding — Tasks 3–4 replace this whole case with a call to `runReconcile`. Keeping it explicit rather than falling through silently means a mistake in Task 2's ordering fails loudly instead of returning `undefined`.)

- [ ] **Step 5: Run — Expected: PASS, unchanged.**
  Run: `npm test && npm run build` — Expected: all 11 existing tests still pass, `tsc --noEmit` clean. `test/op/reconcile.test.ts` requires **zero edits** — if it needs an edit to pass, the refactor broke the call-site compatibility promised in the spec (§3.2); stop and fix the types instead of the test.

- [ ] **Step 6: Commit**
  `git add -A && git commit -m "refactor(reconcile): widen Op reconcile node to discriminated ReconcileOpts"`

---

## Task 2: `Handle.producedAt` + `stamp()` helper

**Files:**
- Modify: `src/handles/handle.ts`, `test/handles/handle.test.ts`

**Interfaces:**
- Consumes: `Handle` (existing), `Clock` (existing, `src/effects/types.ts`).
- Produces: `Handle.producedAt?: number` (additive, optional — no existing construction site breaks); `stamp(h: Handle, clock: Clock): Handle`.

- [ ] **Step 1: Write the failing test**
  Append to `test/handles/handle.test.ts`:
  ```ts
  import { stamp } from '../../src/handles/handle.js'
  test('stamp sets producedAt from the injected Clock without mutating the input', async () => {
    const s = new MemoryStore(); const h = await putText(s, 'x')
    const fakeClock = { now: () => 42 }
    const stamped = stamp(h, fakeClock)
    expect(stamped.producedAt).toBe(42)
    expect(h.producedAt).toBeUndefined()      // original handle untouched
    expect(stamped.r2Key).toBe(h.r2Key)        // same content identity, just annotated
  })
  ```
  (`MemoryStore`, `putText` are already imported at the top of this file per the existing test — verify before assuming; add the imports if the file doesn't already have them.)

- [ ] **Step 2: Run — Expected: FAIL** (`stamp` not exported, `Handle.producedAt` doesn't exist).
  Run: `npx vitest run test/handles/handle.test.ts`

- [ ] **Step 3: Implement**
  In `src/effects/types.ts`, widen `Handle`:
  ```ts
  export interface Handle { r2Key: string; sha256: string; type: string; size: number; producedAt?: number }
  ```
  In `src/handles/handle.ts`, add (needs `Clock` imported):
  ```ts
  import type { Store, Handle, Clock } from '../effects/types.js'
  export const stamp = (h: Handle, clock: Clock): Handle => ({ ...h, producedAt: clock.now() })
  ```

- [ ] **Step 4: Run — Expected: PASS.**
  Run: `npm test && npm run build`

- [ ] **Step 5: Commit**
  `git commit -am "feat(handles): producedAt field + stamp() helper for LWW timestamps"`

---

## Task 3: `lastWriteWins()` reconcile mode

**Files:**
- Modify: `src/op/reconcile.ts`
- Create: `test/op/reconcile-last-write-wins.test.ts`

**Interfaces:**
- Consumes: `Handle[]` (each expected to be `stamp()`-ed — Task 2).
- Produces: `lastWriteWins(handles: Handle[]): Handle`.

- [ ] **Step 1: Write the failing test**
  ```ts
  import { test, expect } from 'vitest'
  import { MemoryStore } from '../../src/effects/types.js'
  import { putText } from '../../src/handles/handle.js'
  import { stamp } from '../../src/handles/handle.js'
  import { lastWriteWins } from '../../src/op/reconcile.js'

  test('lastWriteWins picks the handle with the latest producedAt, regardless of array position', async () => {
    const s = new MemoryStore()
    const early = stamp(await putText(s, 'v1'), { now: () => 10 })
    const late = stamp(await putText(s, 'v2'), { now: () => 30 })
    const mid = stamp(await putText(s, 'v3'), { now: () => 20 })
    const winner = lastWriteWins([early, late, mid])   // `late` is neither first nor last in the array
    expect(winner.r2Key).toBe(late.r2Key)
  })

  test('lastWriteWins breaks ties by later array position, deterministically', async () => {
    const s = new MemoryStore()
    const a = stamp(await putText(s, 'a'), { now: () => 10 })
    const b = stamp(await putText(s, 'b'), { now: () => 10 })   // same timestamp as a
    expect(lastWriteWins([a, b]).r2Key).toBe(b.r2Key)
    expect(lastWriteWins([b, a]).r2Key).toBe(a.r2Key)            // order-dependent, and that's documented
  })

  test('lastWriteWins throws if any handle is unstamped', async () => {
    const s = new MemoryStore()
    const stamped = stamp(await putText(s, 'a'), { now: () => 10 })
    const unstamped = await putText(s, 'b')
    expect(() => lastWriteWins([stamped, unstamped])).toThrow(/producedAt/)
  })

  test('lastWriteWins throws on empty input', () => {
    expect(() => lastWriteWins([])).toThrow(/empty/)
  })
  ```

- [ ] **Step 2: Run — Expected: FAIL** (`lastWriteWins` not defined).
  Run: `npx vitest run test/op/reconcile-last-write-wins.test.ts`

- [ ] **Step 3: Implement**
  Append to `src/op/reconcile.ts`:
  ```ts
  export function lastWriteWins(handles: Handle[]): Handle {
    if (handles.length === 0) throw new Error('lastWriteWins: empty input')
    const unstamped = handles.find(h => h.producedAt === undefined)
    if (unstamped) throw new Error(`lastWriteWins: handle ${unstamped.r2Key} has no producedAt — stamp it via stamp(handle, caps.clock) before reconciling`)
    return handles.reduce((winner, h) => (h.producedAt! >= winner.producedAt! ? h : winner))
  }
  ```

- [ ] **Step 4: Run — Expected: PASS.**
  Run: `npm test && npm run build`

- [ ] **Step 5: Commit**
  `git commit -am "feat(reconcile): last-write-wins mode via Clock-sourced producedAt"`

---

## Task 4: `fieldMerge()` reconcile mode

**Files:**
- Modify: `src/op/reconcile.ts`
- Create: `test/op/reconcile-field-merge.test.ts`

**Interfaces:**
- Consumes: `Handle[]` of `application/json`-shaped content, `Store` (Task 2's `Handle`, existing `Store`).
- Produces: `fieldMerge(handles: Handle[], store: Store, opts?: {defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy>}): Promise<Handle>`.

- [ ] **Step 1: Write the failing test**
  ```ts
  import { test, expect } from 'vitest'
  import { MemoryStore } from '../../src/effects/types.js'
  import { putText, resolveText } from '../../src/handles/handle.js'
  import { fieldMerge } from '../../src/op/reconcile.js'

  test('fieldMerge: default policy — later handle overwrites earlier handle field-by-field', async () => {
    const s = new MemoryStore()
    const a = await putText(s, JSON.stringify({ name: 'alice', age: 30 }), 'application/json')
    const b = await putText(s, JSON.stringify({ age: 31, city: 'nyc' }), 'application/json')
    const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s)))
    expect(merged).toEqual({ name: 'alice', age: 31, city: 'nyc' })
  })

  test('fieldMerge: union policy de-duplicates and concatenates array fields', async () => {
    const s = new MemoryStore()
    const a = await putText(s, JSON.stringify({ tags: ['x', 'y'] }), 'application/json')
    const b = await putText(s, JSON.stringify({ tags: ['y', 'z'] }), 'application/json')
    const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s, { policy: { tags: 'union' } })))
    expect(merged.tags.sort()).toEqual(['x', 'y', 'z'])
  })

  test('fieldMerge: keep-first policy preserves the earliest value despite later overwrites', async () => {
    const s = new MemoryStore()
    const a = await putText(s, JSON.stringify({ id: 'original' }), 'application/json')
    const b = await putText(s, JSON.stringify({ id: 'clobbered' }), 'application/json')
    const merged = JSON.parse(await resolveText(s, await fieldMerge([a, b], s, { policy: { id: 'keep-first' } })))
    expect(merged.id).toBe('original')
  })

  test('fieldMerge throws on non-JSON handle content', async () => {
    const s = new MemoryStore()
    const bad = await putText(s, 'not json', 'application/json')
    await expect(fieldMerge([bad], s)).rejects.toThrow()
  })

  test('fieldMerge throws on empty input', async () => {
    const s = new MemoryStore()
    await expect(fieldMerge([], s)).rejects.toThrow(/empty/)
  })
  ```

- [ ] **Step 2: Run — Expected: FAIL** (`fieldMerge` not defined).
  Run: `npx vitest run test/op/reconcile-field-merge.test.ts`

- [ ] **Step 3: Implement**
  Append to `src/op/reconcile.ts`:
  ```ts
  export async function fieldMerge(
    handles: Handle[],
    store: Store,
    opts: { defaultPolicy?: FieldPolicy; policy?: Record<string, FieldPolicy> } = {},
  ): Promise<Handle> {
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
        merged[k] = v
      }
    }
    return putText(store, JSON.stringify(merged), 'application/json')
  }
  ```

- [ ] **Step 4: Run — Expected: PASS.**
  Run: `npm test && npm run build`

- [ ] **Step 5: Commit**
  `git commit -am "feat(reconcile): field-merge mode for JSON-shaped handles"`

---

## Task 5: Wire both modes into `runReconcile()` + `runInline`

**Files:**
- Modify: `src/op/reconcile.ts`, `src/runtime/inline.ts`
- Create: `test/runtime/inline-reconcile-modes.test.ts`

**Interfaces:**
- Consumes: `lastWriteWins` (Task 3), `fieldMerge` (Task 4), `faithfulUnion` (existing), `ReconcileOpts` (Task 1).
- Produces: `runReconcile(opts: ReconcileOpts, handles: Handle[], store: Store): Promise<Handle>`; `runInline`'s `reconcile` case delegates to it for all three modes.

- [ ] **Step 1: Write the failing test**
  ```ts
  import { test, expect } from 'vitest'
  import { MemoryStore } from '../../src/effects/types.js'
  import { putText, resolveText, stamp } from '../../src/handles/handle.js'
  import { op, pipe, reconcile } from '../../src/op/combinators.js'
  import { runInline } from '../../src/runtime/inline.js'

  test('runInline dispatches last-write-wins end-to-end through a full op tree', async () => {
    const store = new MemoryStore()
    const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
    const tree = pipe(
      op('stampAll', async (handles: any[]) => handles.map(h => stamp(h, { now: () => Math.random() + h.size })), { kind: 'pure' }),
      reconcile({ mode: 'last-write-wins' }),
    )
    const a = await putText(store, 'aa'); const b = await putText(store, 'bbbb')  // different sizes -> deterministic ordering via size-based fake clock
    const result = await runInline(tree, [a, b], caps)
    expect(result.r2Key).toBe(b.r2Key)   // larger size -> larger fake timestamp -> wins
  })

  test('runInline dispatches field-merge end-to-end through a full op tree', async () => {
    const store = new MemoryStore()
    const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
    const a = await putText(store, JSON.stringify({ x: 1 }), 'application/json')
    const b = await putText(store, JSON.stringify({ x: 2 }), 'application/json')
    const tree = reconcile({ mode: 'field-merge' })
    const result = await runInline(tree, [a, b], caps)
    expect(JSON.parse(await resolveText(store, result))).toEqual({ x: 2 })
  })

  test('runInline still dispatches faithful-union unchanged (regression)', async () => {
    const store = new MemoryStore()
    const caps: any = { store, llm: {}, clock: { now: () => 0 }, sinks: {} }
    const a = await putText(store, 'hello\n', 'text/markdown')
    const tree = reconcile({ mode: 'faithful-union' })
    const result = await runInline(tree, [a], caps)
    expect(await resolveText(store, result)).toContain('hello')
  })
  ```

- [ ] **Step 2: Run — Expected: FAIL** (the temporary throw from Task 1 Step 4 fires for the two new modes).
  Run: `npx vitest run test/runtime/inline-reconcile-modes.test.ts`

- [ ] **Step 3: Implement**
  Append to `src/op/reconcile.ts`:
  ```ts
  export async function runReconcile(opts: ReconcileOpts, handles: Handle[], store: Store): Promise<Handle> {
    switch (opts.mode) {
      case 'faithful-union': return faithfulUnion(handles, store)
      case 'last-write-wins': return lastWriteWins(handles)
      case 'field-merge': return fieldMerge(handles, store, opts)
    }
  }
  ```
  Replace the `reconcile` case in `src/runtime/inline.ts`:
  ```ts
  import { runReconcile } from '../op/reconcile.js'
  // ...
  case 'reconcile': return runReconcile(node.opts, input, caps.store)
  ```
  (Delete the temporary `faithfulUnion` import if `runReconcile` now covers every call site in this file — check for other references before removing the import.)

- [ ] **Step 4: Run — Expected: PASS.**
  Run: `npm test && npm run build` — Expected: all tests pass, including every prior task's tests and the original `test/op/reconcile.test.ts` unmodified.

- [ ] **Step 5: Commit**
  `git commit -am "feat(reconcile): wire last-write-wins and field-merge into runInline"`

---

## Task 6: Verify public surface exports + full-repo sanity pass

**Files:**
- Modify (if needed): `src/index.ts`

**Interfaces:**
- Produces: confirmation that `stamp`, `lastWriteWins`, `fieldMerge`, `runReconcile`, `ReconcileOpts`, `FieldPolicy` are all reachable from `@suxos/lib`'s public entry point.

- [ ] **Step 1: Write the failing test**
  ```ts
  import { test, expect } from 'vitest'
  import * as lib from '../src/index.js'
  test('slice-3 reconcile modes are on the public surface', () => {
    for (const name of ['stamp', 'lastWriteWins', 'fieldMerge', 'runReconcile']) {
      expect(typeof (lib as any)[name]).toBe('function')
    }
  })
  ```
  Add this to `test/index.test.ts` (new file) or append to `test/smoke.test.ts` if that file is the established home for surface checks — check `test/smoke.test.ts`'s current content before deciding; don't duplicate an existing surface-check test if one already exists.

- [ ] **Step 2: Run — Expected: PASS already**, since `src/index.ts` does `export * from './handles/handle.js'` and `export * from './op/reconcile.js'`, both of which now include the new symbols (Tasks 2–5 added them to files already re-exported). If it fails, `src/index.ts` needs an explicit addition — check which file's export is missing before guessing.

- [ ] **Step 3: If Step 2 failed, fix `src/index.ts`** to explicitly re-export the missing symbol(s), then re-run.

- [ ] **Step 4: Full-repo sanity pass**
  Run: `npm test && npm run build` — Expected: PASS, zero TypeScript errors, all test files green (baseline 11 + this plan's ~5 new files).

- [ ] **Step 5: Commit**
  `git commit -am "test: confirm slice-3 reconcile modes on the public surface"` (skip this commit if Step 2 already passed with no code change — nothing to commit).

---

## Deferred to a future pass (NOT this plan)

Tracked so nothing is silently dropped — see companion spec §6, §7:
- Entity resolution / dedupe (Splink or any alternative) — closed per spec §2.1, not merely paused.
- `runDurable`/`interpretDurable` wiring for these modes in the `sux` repo (out of scope: repo boundary).
- `Clock` sourcing for `last-write-wins` under durable replay (workflow-instance-local clock) — flagged in spec §7, needs its own design when `sux`-side wiring is picked up.
- Recursive/nested `field-merge`, and `'union'` policy validation on non-array fields — widen only when a real caller needs it.
- A bespoke MCP `search_tools` surface — confirmed still correctly deferred (spec §2.4); no build task here.

---

## Self-Review

**Spec coverage:** `last-write-wins` (Tasks 2–3, wired in 5) ✓; `field-merge` (Task 4, wired in 5) ✓; `ReconcileOpts` refactor with zero breakage to the existing faithful-union test (Task 1, guarded at every subsequent task) ✓; entity resolution correctly excluded, not attempted (Global Constraints, Deferred section) ✓; public-surface reachability checked explicitly (Task 6) rather than assumed.

**Placeholder scan:** the only intentional stub is Task 1 Step 4's temporary `throw` for unwired modes — it exists for exactly one task's duration (replaced in Task 5) and fails loudly rather than silently, so it can't be mistaken for a real implementation gap if the plan is interrupted mid-way.

**Type consistency:** `Handle` (Task 2) is used identically by `lastWriteWins` (Task 3) and `fieldMerge` (Task 4); `ReconcileOpts` (Task 1) is the single source of truth consumed by `reconcile()` (Task 1), `runReconcile()` (Task 5), and nothing else redeclares the mode union.

**Repo boundary check:** every file path in this plan is under `suxlib/` (specifically `src/handles`, `src/op`, `src/runtime`, `src/index.ts`, and their `test/` mirrors). No task touches `sux`, `sux-fileops`, `.github`, or `claude-config`.
