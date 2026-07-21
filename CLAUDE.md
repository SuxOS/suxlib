# CLAUDE.md — working in suxlib

`@suxos/lib` is SuxOS's shared, dependency-light **pure core + adapters** library and
the home of the **op engine** (`op`/`map`/`reconcile`/`pipe`/`sink`/`ask`, the
`runInline`/`runDurable` graduated runtime). It **absorbs `sux-fileops`** — that repo's
pure core (archive/pdf/sanitize/transform) now lives here under `src/domain/*`, with
generalized CLI/HTTP/MCP adapters over the same functions; `sux-fileops` itself is
retired (deprecated, not deleted — see its README). Deep design lives in `sux`'s
`docs/superpowers/specs/2026-07-15-suxos-v2-op-engine-design.md` and the paired
walking-skeleton plan; this file is **how we work**, not what we're building. Universal
cross-project rules live in `~/.claude/CLAUDE.md`.

Guiding principle: **git is the undo, CI is the gate, review is the net** — so we move
fast and unblocked, and lean on those three instead of asking permission.

## Layout

- `src/domain/*.ts` — pure functions: `(Uint8Array | string, opts) => output`. No
  `fetch`, no ambient `fs`, no KV. `archive.ts` (zip/tar/gzip + the op-engine `unzip`
  leaf), `sanitize.ts` (image metadata strip + PII redaction), `transform.ts`
  (json/yaml/csv/xml/markdown/html), `pdf.ts` (shrink/page-count), `text.ts`
  (pdf-to-markdown/summarize leaves — these two are LLM-`effect` leaves, not pure
  functions, since they call the injected `Llm` capability).
- `src/op/*`, `src/handles/*`, `src/control/*`, `src/effects/*`, `src/runtime/*` — the
  op engine: typed op-tree combinators, content-addressed `Handle`/`Store`, reliability
  primitives (AIMD, backoff, idempotency), capability interfaces, and `runInline`. The
  durable (`Workflows`) runtime lives in the `sux` Worker (`sux/sux/src/op-engine/*`),
  since it's Cloudflare-binding-specific; this repo stays platform-agnostic.
- `src/adapters/*.ts` — thin I/O glue over `src/domain/*`, generalizing `sux-fileops`'s
  three-surface pattern: `cli.ts` (`bin/fileops.mjs` — archive/pdf/sanitize/transform
  subcommands), `http.ts` (Cloudflare Worker fetch handler; JSON in with base64 for
  bytes, JSON out), `mcp.ts` (`registerFileopsTools(server)` for
  `@modelcontextprotocol/sdk`). **A change to a domain function should keep all three
  adapters in sync** — they share the surface; adjust CLI/HTTP/MCP together when you
  rename or reshape a domain export.
- `test/**` mirrors `src/**` — the "1 test file · 1 source file" convention (see
  `src/op/reconcile.ts` + `test/op/reconcile.test.ts` as the reference pair). Domain
  logic is pure, so its tests need no mocks; adapter tests are contract/wiring tests —
  the business-logic edge cases belong in the domain test, not re-asserted per adapter.

**Package exports** (`package.json`): `"."` is the pure core + op engine (no
CLI/HTTP/MCP dependencies pulled in — this is what `sux` and other Worker consumers
import). The adapters are separate subpath exports (`./adapters/cli`,
`./adapters/http`, `./adapters/mcp`) so a consumer that only wants `domain/*` or the op
engine doesn't drag in `commander`/`zod`/`@modelcontextprotocol/sdk`.

**Source-distributed, no publish step.** `exports["."]` points straight at
`src/index.ts` — there is no `dist/` and no npm registry publish. Consumers (`sux`)
depend on this repo as a git/file dependency (`"@suxos/lib": "file:../suxlib"` when
checked out as a sibling directory, or `"github:SuxOS/suxlib"` otherwise) and their own
bundler (esbuild via `wrangler`, or `tsx`) compiles the TS on the fly. `bin/fileops.mjs`
therefore shells out to `tsx` rather than requiring a build step of its own.

## CI gates — don't break these (`.github/workflows/ci.yml`)

Both must pass:

1. `npm test` — `vitest run`
2. `npm run build` — `tsc -p tsconfig.json --noEmit` (strict mode is on; this is a
   type-check only, no emit — there's nothing to commit as build output)

There is no linter in this repo. Run both locally before pushing.

## Git & branches

- **Never commit to `main`.** Treat every merge as a release for downstream consumers
  (`sux` depends on this repo directly) — `main` must always be green.
- **Branch per logical change**: `<type>/<slug>` — `feat/…`, `fix/…`, `docs/…`,
  `chore/…`. One workstream per branch.
- **Commits**: Conventional Commits — `feat: …`, `fix: …`, `docs: …` (see the existing
  history for the house style: no scope prefix has been used so far — keep it that way
  unless a change is genuinely scoped to one subsystem). Granular, well-described. End
  every commit with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Update a branch by rebasing onto `main`** (`git rebase main`) — never merge `main`
  back in.
- **`git fetch origin main` before trusting a local `main`/`origin/main` ref to
  decide whether a prerequisite has merged.** A fresh checkout's local refs can be
  stale relative to what's actually on GitHub — confirmed when #301 (which depends
  on #297's `Concurrency.acquire(signal?)`) initially looked unbuildable against a
  stale local `main` that predated #297's merge, until an explicit fetch picked up
  the real tip. Symptom: grepping `src/` for a prerequisite's symbol comes up empty
  even though `gh pr list --search "<issue>" --state all` shows it merged — fetch
  before concluding "not merged yet" and dropping/reimplementing.
- **Integrate via PR.** PR bodies end with:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- **Before merging anything substantial: run `/code-review`.** Findings-fix rounds
  before merge are the norm, not the exception.
- **Self-isolate work in a git worktree**: `git worktree add .scratch-worktrees/<slug>
  -b <type>/<slug>` — don't work directly on a checked-out branch that another
  session/task might also be touching.
- **Before reimplementing a requeued issue, check for a stale closed-PR builder
  branch**: a prior attempt's branch (`git fetch origin
  bot/issue-build-<run-id>`, findable via the issue's own comment history/linked
  PRs) can still exist even after its PR was closed without merging — diff it
  against current `main` for the relevant path (`git diff main <branch> --
  <path>`) to turn a from-scratch design task into a verify-and-adapt one. Don't
  merge/cherry-pick it wholesale though — it may predate a feature that's since
  landed on `main` (see #143/#162), so reimplement against current `main` using
  it as a reference, not a patch. When several sibling stale branches exist for
  the same issue (multiple prior batches each attempted it independently),
  they can diverge in actual design/naming — and a since-filed follow-up issue
  for the "next increment" may describe function/line details from a sibling
  attempt that wasn't the one ultimately merged (#143's own follow-ups, #145
  and #161, cite a `validatePipeShapes` name/lines that don't match the
  `shapeCompatible`/`stepShape` implementation that actually landed from a
  different sibling branch) — verify a follow-up issue's cited names/lines
  against current code rather than trusting them verbatim.
- **A follow-up issue can be filed against a prerequisite that hasn't merged
  yet.** #242 (trace snapshot budget guard, follow-up to #234) and #250/#251
  (follow-ups to #247's sink governance) were all still queued as buildable
  while #234 and #247 themselves sat unmerged in their own open PRs (#241,
  #249) — so the feature/field the follow-up describes (`trace: 'full'`,
  `SinkOpts`, `sink.fanout(names, opts?)`) doesn't exist on `main` at all yet.
  Before building a follow-up issue, grep current `main` for the symbol it
  names; if absent, check whether the prerequisite issue is still open with
  an unmerged PR and drop the follow-up as blocked (not superseded) rather
  than reimplementing the prerequisite yourself and risking duplicate/
  conflicting work when that PR lands. Update (#267): don't stop at "still
  unmerged" — check *why* with `gh pr checks <prereq-pr>` /
  `gh run view <run-id> --log-failed`. #241 (#234) and #249 (#247) are each
  stuck on one concrete, fixable CI failure, not flakiness: #241 fails
  `security-review` with exactly the finding #242 itself describes
  (`snapshotValue()` has no byte/node-count budget); #249 fails `Test &
  build` because the sink-governance change broke per-target trace emission
  for sink fanout
  (`test/runtime/inline-trace.test.ts > runInline traces a sink fanout`). A
  batch that lands #234 or #247 should fix that PR's own failure as part of
  the same change (folding #242's budget guard into #241's work, fixing the
  trace regression as part of #249's work) — that closes the follow-up issue
  as a side effect instead of every future batch re-claiming and re-dropping
  #242/#251 as a no-op forever. Update: #247 landed this way, but via a
  *different* PR than the one this note originally named — #249 itself was
  closed unmerged; #281 ("feat: per-file --mtime for CLI archive create;
  gate sink writes through runGoverned") is the PR that actually fixed the
  trace regression and merged, closing #247 (and #246). #251 (per-target
  sink.fanout opts) built cleanly on top once #247 landed. #234/#241 (the
  `trace: 'full'` snapshotValue budget guard, #242's prerequisite) were
  still open/stuck as of this note — don't assume a prerequisite's PR number
  stays fixed once you go looking; re-check via `gh pr list --search
  "<issue>" --state all` rather than trusting a previously-recorded PR
  number.

## Consumers

- **`sux`** (the Cloudflare Worker) — depends on `@suxos/lib` for the op engine
  (`src/op-engine/*` compiles an `Op` tree onto Cloudflare Workflows) and for the
  domain functions backing `src/fns/{archive,pdf,_convert,redact}.ts` (thin
  delegating wrappers where the fn's scope matches a domain function 1:1; `pdf.ts`'s
  full multi-source PDF *builder* and `image_convert.ts`/`compress.ts`'s
  Cloudflare-binding/multi-codec logic exceed sux-fileops's ported v1 scope and stay
  local to `sux` — don't try to fold those into `suxlib/domain/*` without a scoped
  design pass first).
- **`sux-fileops`** — retired; kept read-only for history, not a consumer going
  forward. Don't add new features there — extend `src/domain/*` and its adapters here
  instead.

## House style

- No trailing/inline comments explaining the obvious; comment *why*, not *what*.
- Bidirectional naming (a reader can go name→behavior and behavior→name).
- Keep `src/domain/*` and `src/op/*`/`src/control/*` dependency-light and
  side-effect-free; push I/O to `src/adapters/*` and `src/effects/*` capabilities.
- Match surrounding code's idiom (2-space indent, single quotes, no semicolons in
  `src/op|control|handles|effects|runtime`; the ported `src/domain/*` and
  `src/adapters/*` files also use 2-space/single-quote but keep semicolons, matching
  their sux-fileops origin — don't reformat a whole file just to unify this).
- One change per cycle; land it green before starting the next.
- When merging duplicated logic that existed in more than one place (e.g. this repo's
  absorption of `sux-fileops`, which itself had partially diverged from `sux`'s
  original `src/fns/*`), reconcile behavior differences deliberately rather than
  picking one side arbitrarily — take the more defensive/correct version of each
  guard (bomb caps, prototype-pollution guards, escaping) even if it means neither
  original file is byte-for-byte what ends up here.
- fflate gotcha: `unzipSync`'s declared `originalSize`/`size` fields (central
  directory) are attacker-controlled and are used to preallocate a fixed output
  buffer that silently does *not* resize on overflow — trust actual streamed bytes
  (fflate's `Unzip`/`UnzipInflate`, or `Gunzip` as `gunzipCapped` already does), never
  the declared header value, for any bomb-guard byte accounting. Separately, `Unzip`'s
  streaming parser (unlike `unzipSync`) does not throw on malformed/non-zip input —
  it just silently finds zero entries — so if you touch `unzipGuarded` in
  `src/domain/archive.ts`, keep (or replace with an equivalent) the `unzipSync`
  validation pre-pass that gives corrupt-input callers a real error. Also: both
  `zipSync` and `unzipSync` (not just our own code) key an *internal* plain object by
  entry name and assign to it directly, so an entry literally named `__proto__` hits
  the same Annex-B setter bug inside fflate itself — `zipSync` throws a confusing
  `TypeError` reading `.level`, `unzipSync` silently returns that entry via
  `Object.keys() === []`. This isn't fixable by making *our* objects
  `Object.create(null)` (that only protects our own record/files objects, e.g. in
  `zipCreate`/`unzipGuarded`'s streaming `Unzip` path) — a name of exactly
  `'__proto__'` must be rejected before it ever reaches `zipSync`, and any future
  codepath calling `unzipSync` directly (not the streaming `Unzip` class) needs the
  same awareness. Also: `zipSync`'s per-entry `mtime` is DOS date/time encoded, which
  can't represent anything before 1980 — `mtime: 0` throws `'date not in range
  1980-2099'` (unlike `gzipSync`, where `mtime: 0` is the documented "omit the
  timestamp" sentinel, and unlike `tarCreate`'s plain-Unix-timestamp `mtime ?? 0`).
  `zipCreate` defaults to `ZIP_EPOCH` (1980-01-01 UTC) instead, for the same
  deterministic-output goal. Update: fflate's zip writer reads the DOS year back out
  via *local*, not UTC, `Date` getters, so a `Date.UTC(1980, 0, 1)` constant reads
  back as 1979 (retriggering the same throw) on any host whose TZ is behind UTC —
  `zipCreate` now builds this fallback with the local `Date` constructor instead,
  and recomputes it per call (not as a module-level constant) so it tracks the
  process's TZ at call time rather than whatever TZ was active at import.
- pdf-lib gotcha (`src/domain/pdf.ts`, #351): `PDFDocument.save()`'s writer
  (`PDFWriter`/`PDFStreamWriter`) serializes every object in
  `context.enumerateIndirectObjects()` unconditionally — it does not do a
  reachability walk from the trailer/catalog. Deleting a dict's reference to
  an indirect object (`dict.delete(name)`) only unlinks it; the object's
  bytes still round-trip into the output unless you *also*
  `context.delete(ref)` the object itself. Any future feature that means to
  drop PDF content (not just stop referencing it) needs both calls, the way
  `pdfShrink`'s XMP-stripping fix does.
- `src/domain/transform.ts`'s `toXml`/`parseXml` marker-attribute scheme
  (`EMPTY_ARRAY_ATTR`/`SINGLE_ARRAY_ATTR`/`NULL_VALUE_ATTR`/`NESTED_ARRAY_ATTR`) has
  a gotcha of its own: `attach()`'s promote-on-repeat logic used to infer "this key
  was already promoted to an array" purely from `Array.isArray(node[name])` — which
  breaks the instant a *value itself* is an array (a single-array or nested-array
  child looks identical, by shape, to an already-promoted accumulator). `attach()`
  now takes an explicit `forceArray` flag and tracks forced keys per-node in a
  `WeakMap` instead of inferring from shape — any future marker attribute whose
  decoded value can itself be an array must thread through that same `forceArray`
  path rather than relying on `Array.isArray(cur)`.
- `src/domain/transform.ts`'s `inlineMdToHtml` placeholder-pool trick (shielding
  code-span/link content from the later `**`/`__`/`*`/`_` emphasis regexes via
  `\x00N\x00` tokens) must protect exactly the sensitive substring, not the whole
  enclosing construct — pooling the entire `<a href="...">${txt}</a>` output (#321's
  fix for the href-corruption bug #317) also swallowed the link *text*, silently
  breaking emphasis markers inside link text (#323). Push only `sanitizeUrl(href)`
  into the pool and leave `txt` in the template literal so later passes still reach
  it. Update (#328): the four emphasis regexes themselves had two more bugs from
  the same root cause (flat regex passes with no delimiter-nesting or HTML-tag
  awareness) — `**`/`__`'s `[^*]+`/`[^_]+` content class rejected any nesting
  (`**bold *italic* still bold**` left the outer `**` unmatched entirely, so the
  later `*`/`_` em pass then matched two unbalanced fragments across it), and none
  of the four excluded `<`/`>`, so a stray unpaired `*`/`_` in one link's text
  (`[*foo](...)`) could match all the way through to a stray partner in a
  *different* link's text, swallowing the `</a>...<a href=...>` between them as
  "emphasis content." Fixed by making `**`/`__` lazy (`[^<>]+?`, allowing a single
  nested `*`/`_` through so the subsequent em pass still finds and wraps it) and
  adding `<`/`>` to all four content classes (so no emphasis span can cross a tag
  boundary the link/code pass already inserted). Any future change to these four
  regexes should keep both properties — lazy quantifiers for the double-delimiter
  pairs, and `<`/`>` excluded from every content class — rather than reverting to
  a plain `[^*]+`-style class.
- `src/domain/transform.ts`'s YAML `parseYaml` used to have the same naive,
  quote-unaware `[^:]+?`-style "split on the first colon" regex independently
  copied into four places (`splitKey`, `detectBlockScalarMinIndent`'s two
  branches, and `parseSeqItem`'s inline-key check) — a quoted mapping key
  containing a colon (`"a: b": |`) broke block-scalar detection and seq-item
  key parsing in each copy on its own, since fixing one didn't fix the others
  (#401). All four now share one `splitMappingKey(body)` helper; any future
  YAML key-parsing tweak belongs there, not re-derived at a new call site.
- Governor convention: `runInline` retries every leaf (`LeafOpts.retries`, any
  `kind`) through `runGoverned` (`src/control/governor.ts`); `tokenBucket`/
  `circuitBreaker` gating for `effect` leaves is configured separately, via
  `Caps.governors: Record<leafName, Governor>`, not `LeafOpts` — those primitives
  hold mutable state that must persist and be shared across calls, which
  per-leaf declarative opts can't express. A future `sux`-side `runDurable`
  should reuse `runGoverned` (passing a durable `sleep`) rather than
  reimplementing the retry/gating logic. `runGoverned`'s half-open-probe cap
  (one in-flight probe per breaker, guarding the livelock in spec §7) is
  tracked in an in-process `WeakMap` keyed off the `CircuitBreaker` instance —
  fine for `runInline`, but a durable runtime whose steps can resume in a
  different isolate will need that cap made durable too (e.g. state on the
  breaker itself, or persisted alongside the workflow run) rather than
  inheriting the `WeakMap` as-is. Update: this has been addressed at the
  interface level — `CircuitBreaker` now owns `reserveHalfOpenProbe()`/
  `releaseHalfOpenProbe()` (`src/control/circuit-breaker.ts`), and
  `runGoverned` calls those instead of a WeakMap. The in-memory
  `circuitBreaker()` still backs them with a plain in-process flag, so a
  future `sux`-side durable `CircuitBreaker` implementation must back those
  same two methods with persisted state to actually close the gap. Update: the
  third §3.3 gate is now wired too — `Governor.concurrency` (any `Concurrency`,
  e.g. `aimd()`/`fixed()` from `src/control/aimd.ts`) is acquired/released by
  `runGoverned` after the token-bucket take and before the effect call, same as
  breaker/token-bucket: only for `'effect'` leaves, and freshly per retry
  attempt (not held across a backoff sleep), so a slow/failing leaf doesn't pin
  a slot idle while it waits to retry. Update: `runInline` (`src/runtime/inline.ts`)
  now takes an optional 4th `gOpts?: RunGovernedOpts` param, threaded unchanged
  through `'pipe'`/`'map'` recursion into every `runGoverned` call — this is the
  only way a caller reaches `onEvent`/custom `backoff`/`sleep`/`rand`, since
  `LeafOpts` carries no such per-run knobs. `createGovernor(name, spec, onEvent)`
  (`src/control/governor.ts`) builds a leaf's breaker/tokenBucket/concurrency
  together and tags each one's emitted `GovernorEvent` with `name` (now optional
  on every variant but `retry-attempt`) — pass the same `onEvent` function to both
  `createGovernor` (per leaf, at `caps.governors` construction time) and
  `runInline`'s `gOpts.onEvent` (once, per run) to get one leaf-labeled stream
  instead of wiring a matching callback into each primitive by hand. Update
  (#215): per-node execution tracing (`{tag, name?, path, durationMs, ok,
  error?}` node-enter/node-exit around every `runInline` switch case, not
  just governed leaves) is a deliberately *separate* `RunGovernedOpts.onTrace`
  stream (`src/control/trace.ts`), not an extension of `GovernorEvent`/
  `onEvent` — several existing `onEvent` consumers (tests and, potentially,
  production wiring) assert exact event sequences, and a trace fires once per
  node the tree visits, which would silently flood/break every one of them.
  `onTrace` rides the same already-threaded `gOpts` bag, so it's reachable
  from `POST /op/run`/`run_pipeline`/`pipeline run` via `opRunGOpts.onTrace`
  with zero adapter changes. Update (#247): a `sink` node's per-target write
  now goes through `runGoverned` too, via an opt-in `SinkOpts` (`retries`/
  `heavy`/`memo`, same shape as `LeafOpts` minus `kind` — a sink write is
  always I/O) on `Op`'s `sink` variant. Each target is gated by
  `caps.governors["sink:<target>"]`, not `caps.governors["<target>"]` — the
  `sink:` prefix is deliberate, so a sink target's governor entry can never
  collide with a same-named leaf's own. `opts` applies uniformly to every
  target in one `sink.fanout(names, opts)` call (which moved from a vararg
  target list to `(names: string[], opts?: SinkOpts)` to make room for this);
  there's no way to give two targets in the same fanout different retry
  policies short of two separate `sink()` calls composed some other way.
  Gotcha this surfaced: `runInline`'s `case 'sink'` used to fan out via
  `Promise.all`, which resolves as soon as the first target settles — fine
  when every write was one bare microtask deep, but `idempotencyKey()`
  (`src/control/retry.ts`) now runs on every gated target via
  `crypto.subtle.digest`, which is real dispatched async work with
  non-deterministic relative timing across concurrent calls. That turned the
  existing "each target traces independently" test flaky (a faster target's
  `sink-target` node-exit sometimes hadn't landed yet when `Promise.all`
  rejected on a slower one) — fixed by switching to `Promise.allSettled` and
  rethrowing the first rejection only after every target has fully settled.
  Any future fan-out over multiple gated (`'effect'`-kind) calls sharing one
  `onTrace`/result array should default to `allSettled` for the same reason:
  once a call path involves genuine async work (crypto, network, timers)
  rather than bare microtasks, `Promise.all`'s early-settle behavior stops
  being safe to race against side effects the losing branches are still
  producing.
- Cancellation convention (#279): `RunGovernedOpts.signal?: AbortSignal`
  (`src/control/governor.ts`) is cooperative, not preemptive — it never kills
  an in-flight leaf/sink effect call itself, only stops the tree from
  *starting* further work once aborted. Two checkpoints cover it: `runInline`'s
  `traced()` wrapper (`src/runtime/inline.ts`) checks `gOpts.signal?.aborted`
  once, at the top, before dispatching *any* node (leaf, pipe step, map/
  mapField item, reconcile, sink fanout/target, ask, catch's try) — since every
  one of those passes through `traced()` regardless of tag, one check there
  covers every checkpoint the #279 issue asked for. `runGoverned`'s retry loop
  checks the same signal again at the top of every attempt (a leaf's own
  retries are invisible to `traced()`, which spans the whole retry loop as one
  node), and races its backoff sleep against the signal (`sleepOrAbort`) so an
  abort doesn't have to wait out the full backoff delay. Thrown as a dedicated
  `OpAbortError`, deliberately not a plain `Error`/`DOMException` — `runInline`'s
  `catch` case re-throws it past the fallback instead of treating it as "the
  try branch failed, run the fallback," since an abort is a control signal from
  outside the tree, not an application error the tree is expected to recover
  from. `http.ts`'s fetch handler and `mcp.ts`'s `run_pipeline` tool both wire
  the adapter's own signal (`Request.signal` / MCP's `RequestHandlerExtra.signal`)
  into `gOpts.signal` unless a host-supplied `opRunGOpts.signal` already set
  one — note MCP's client-side cancellation always rejects the *client's*
  `callTool()` promise immediately on abort regardless of server behavior, so
  testing the server-side stop-the-next-step effect needs a real mid-flight
  delay + a server-side side-effect flag, not just asserting on the client
  promise's settlement (see `test/adapters/mcp.test.ts`'s mid-flight
  cancellation test). Primitives below the checkpoint level (`tokenBucket`,
  `concurrency`/aimd, a leaf's own in-flight effect) are not signal-aware —
  matching the issue's own scoping, this stays a checkpoint-based scheme, not
  a preemptive-kill one. Update (#297): `tokenBucket.take`/`Concurrency.acquire`
  (`src/control/token-bucket.ts`, `src/control/aimd.ts`) are now signal-aware
  too, so a leaf queued behind a starved bucket or a full limiter can be
  cancelled without waiting for a slot — same "checkpoint, not preemptive"
  rule: once a slot is actually granted it's never revoked. `OpAbortError`/
  `sleepOrAbort` moved to a new dependency-free `src/control/abort.ts` (re-
  exported from `governor.ts` for backward compat) specifically so
  token-bucket.ts/aimd.ts could throw/race the same error without an import
  cycle back through governor.ts, which imports both — reach for that pattern
  again (a tiny shared leaf module, not a re-export chain) any time a
  primitive `governor.ts` builds needs to share an error type or helper with
  `governor.ts` itself. `runGoverned`'s catch block now checks `err instanceof
  OpAbortError` (after concurrency/probe cleanup, before breaker bookkeeping)
  since these two primitives can now throw it from inside the try — without
  that check it'd be misclassified as a leaf failure (breaker.onFailure,
  a spurious retry-attempt event), the same class of bug #275's post-success
  guard exists to prevent. Left un-threaded: `runInline`'s own `map`/
  `mapField` item-level `node.concurrency.acquire()` calls (`src/runtime/
  inline.ts:58,72`) — a different, unnamed limiter from `governor.ts`'s
  per-leaf one, out of #297's stated scope, so a map item queued behind a
  full fan-out limiter still can't be cancelled early. Update: #303 (open PR
  #308) and #234 (open PR #241) are both stuck on the *same* org-level infra
  gap #320 tracks — `.suxos-ci/scripts/classify-security-noverdict.sh` is
  missing from the reusable `security-review` workflow, so it fails closed
  on every PR that hits it regardless of diff content. #309 (proposing
  `runGoverned`'s catch use a neutral-release outcome, matching #303's fix)
  and #242 (a snapshot-byte budget guard on #234's `trace: 'full'` feature)
  are follow-ups to those two still-unmerged PRs — grepped `Concurrency`
  (`src/op/types.ts`) and `src/control/trace.ts` as of this note and neither
  `releaseCancelled()`/`releaseNeutral()` nor `snapshotValue`/`traceSnapshots`
  exist on `main` yet. Don't reimplement either prerequisite speculatively to
  unblock its follow-up — a prior stale branch (`bot/issue-build-29707704140`,
  PR #304, closed unmerged) already found #303 actually landed the method as
  `releaseCancelled()`, not the `releaseNeutral()` name #309 itself guesses,
  so building the follow-up first risks a name mismatch/duplicate interface
  member once the real PR lands. Drop #309/#242 as blocked (not superseded)
  until #308/#241 merge, and re-check `gh pr checks 308`/`241` rather than
  assuming the infra gap is still open by the time either issue is next
  claimed. Update (2026-07-20): re-checked per the above — both still fail
  `security-review` on the identical missing-script error, so #309/#242 were
  dropped again unbuilt. #172 (bare-Handle `params` guard)/PR #173 is a third,
  independent instance of the same #320 gap blocking an otherwise-complete,
  ready-to-merge fix — with the gap still open, assume *any* issue that looks
  freshly buildable may already have a stuck-but-still-OPEN PR against it;
  `gh pr list --search "<issue>" --state all` before building, not just for
  closed/superseded branches. #320 itself was labeled `needs-human` after two
  consecutive daily batches independently rediscovered it as unfixable from
  suxlib (the script and its home repo, SuxOS/.github, aren't reachable from
  here at all) — nothing left for a builder to do on it short of that label,
  so stop requeuing it until a human restores the upstream script. Update
  (2026-07-20, later batch): #309/#242 re-checked again via `gh pr checks
  308`/`241` — both still fail `security-review` on the same missing-script
  error, so both stayed dropped, unbuilt. Gotcha that nearly caused a bad
  build this round: `git log origin/main --oneline --all | grep <name>` can
  match a commit that only exists on an unmerged PR's remote-tracking ref
  (`--all` walks every ref, not just `main`) — `git show <sha>` on that
  commit then looks exactly like real, landed code (full diff, real file
  contents), with nothing in the output itself flagging it as unmerged. This
  is exactly how a prior run first mis-confirmed #303's `releaseCancelled()`
  naming (correctly, since that stale branch was later confirmed against
  main) but a *different* run could just as easily use the same command to
  wrongly conclude a still-open PR's commit is already on `main` — always
  cross-check with `git merge-base HEAD origin/main` (or `git log
  origin/main` without `--all`) before trusting a symbol/commit found via
  `--all` actually exists on `main`, not just on some branch. #337 (the
  second, distinct security-review failure mode — shallow checkout / no
  merge-base — filed to track the gap left after #320's fix) was dropped a
  second time this round for the same reason #320 was: the root cause lives
  entirely inside `SuxOS/.github`'s reusable `security-review.yml`, which
  this repo's own `.github/workflows/security-review.yml` only ever
  `uses:` with no fetch-depth override available to it — labeled
  `needs-human` on this, its second independent confirmation, same
  two-strikes precedent as #320. #324 (streaming/chunked domain+Store path)
  and #326 (TS/tsconfig convergence with `sux`) were dropped again too: #324
  names its own need for a design pass before implementation, and #326
  requires a coordinated change in the `sux` repo, which isn't reachable
  from a suxlib-only session — neither is a fit for a low-priority batch
  regardless of turn/time budget available. Update (2026-07-20, this batch):
  #242/#309 re-checked once more via `gh pr checks 241`/`308` — both
  prerequisite PRs (#241 for #234, #308 for #303) are still open and still
  fail `security-review` on the identical #320 missing-script error, and
  `grep -rn "snapshotValue\|traceSnapshots\|releaseCancelled" src/` still
  comes up empty on `origin/main`, so both stay dropped, unbuilt, not
  superseded. #324/#326 hit their *sixth* consecutive drop this round, each
  for the same structural reason every prior batch found (#324 needs a
  design pass a low-tier batch can't do; #326 needs the `sux` repo, which
  is never checked out in this session — confirmed again via `find /
  -maxdepth 3 -iname sux`, nothing). That clears the same "repeated
  independent confirmation" bar #320/#337 were labeled `needs-human` under,
  and #314 (filed after #313 hit the identical dispatcher-reselects-a-
  permanently-blocked-issue pattern for #264) confirms directly: labelling
  the offending issue `hold`/`needs-human` is the actual fix, since both
  labels are already an EXPAND exclusion signal this task's own instructions
  honor, so the low-tier dispatcher almost certainly does too. Labelled
  both `needs-human` this batch rather than dropping a seventh time. Update
  (2026-07-20, batch building #351/#350/#352): #242/#309 re-checked yet again
  — `gh pr checks 241`/`308` both still fail `security-review` on the
  identical `.suxos-ci/scripts/classify-security-noverdict.sh: No such file
  or directory` error, and `grep -rn "snapshotValue\|releaseCancelled" src/`
  is still empty on real `origin/main`. Nearly got fooled the same way this
  note already warns about: `git log --oneline --all | grep <name>` (the
  `--all` walks every ref, not just `main`) surfaced `3f7ecaa` looking like
  landed `releaseCancelled` code — `git merge-base --is-ancestor 3f7ecaa
  origin/main` (exit 1) caught that it's only on the stale, closed-unmerged
  `bot/issue-build-29707704140` branch. Dropped both again, unbuilt, not
  superseded.
- Ask convention: the `ask` op node's `timeout` (`src/op/types.ts`) is a raw
  string, not milliseconds — `runInline` (`src/runtime/inline.ts`) passes it
  through uninterpreted to `caps.ask.request(prompt, timeout)` rather than
  inventing a duration-parsing scheme this repo doesn't otherwise have. With no
  `Ask` capability supplied, `runInline` honors `onTimeout` itself (throws
  `AskTimeoutError` on `'fail'`, proceeds with the piped value on `'proceed'`)
  since an inline run has no way to actually pause for a human answer. A future
  `sux`-side `Ask` implementation owns defining/parsing the timeout format as
  part of building real pause/resume — don't add parsing here without a scoped
  design pass.
- Leaf-naming convention: each `src/domain/*.ts` pure function that also gets a
  Handle-based `LeafFn` wrapper (for op-tree use, `unzip`'s pattern) needs a
  *different* export name than the pure function, since both live in the same
  module — `archiveCreate`/`archiveExtract` → `pack`/`unpack`, `pdfShrink` →
  `shrink`, `redactText`/`sanitizeImage` → `redact`/`scrub`, `dispatchTransform`
  → `convert`. Each wrapper resolves its input Handle(s) via `caps.store`, calls
  the pure function unchanged, and `putBytes`/`putText`s the result back to a
  Handle — no extra validation beyond what the pure function already does.
  `unzip` itself stays untouched (zip-only, exact signature already depended on
  by `sux`'s tracer-bullet op tree) rather than being folded into `unpack`.
  The same collision can happen *across* two different modules, not just
  within one: `src/index.ts`'s `export *` barrel re-exports every top-level
  module, so a new module whose export shares a name already used elsewhere
  in the barrel (e.g. `src/op/reshape.ts`'s `stamp` leaf colliding with
  `src/handles/handle.ts`'s raw `stamp(h, clock)` helper, #142/#133) fails
  only `npm run build` (`tsc`'s "already exported a member" error) — `npm
  test` stays green, since vitest doesn't type-check the barrel — so always
  run both gates, and grep `src/index.ts`'s re-exported modules for an
  existing same-named export before picking a new leaf/helper's name.
- Memoization convention: `LeafOpts.memo` (opt-in per leaf, independent of
  `kind`/`heavy`) makes `runGoverned` (`src/control/governor.ts`) check
  `caps.cache` for a prior result — keyed by `memoKey(name, input)`
  (`src/control/memo.ts`, reusing `retry.ts`'s `canonicalize()`) — before
  running the leaf at all, and writes a successful result back under that key
  after. This dedupes identical `(leaf, input)` calls *across* separate
  calls/runs; it's deliberately a different key space (`memo:` prefix) from
  `idempotencyKey`, which instead dedupes retry *attempts* within one
  `runGoverned` call and is handed to the effect fn itself. With no
  `caps.cache` wired, `memo: true` is a silent no-op (same degrade-gracefully
  pattern as `caps.ask`) — this repo doesn't decide *which* leaves opt in
  (that's `sux`'s op-tree construction call site, same as `heavy`/`kind`) or
  ship a durable `Cache` implementation, only `MemoryCache`
  (`src/effects/types.ts`) for inline/test use.
- Leaf composability gotcha: each Handle-based leaf wrapper's input shape is
  chosen independently (`shrink`/`redact`/`convert` want `{handle, ...opts}`,
  `pack` wants `{format, files}`, `scrub`/`unzip` take a bare `Handle`), so only
  leaf pairs whose shapes happen to already align compose directly via
  `pipe`/`map` — e.g. `unzip`'s `Handle[]` output feeds `map(scrub)` cleanly
  since `scrub` also takes a bare `Handle`, but nothing chains into `shrink`/
  `redact`/`convert` without a reshaping step first, since their `{handle,
  ...}` input never matches another leaf's raw output. `src/op/spec.ts`'s JSON
  op spec (leaf/pipe/map over `src/op/registry.ts`, added for #113) inherits
  this as-is rather than solving it — a caller chaining shape-incompatible
  leaves still needs a reshape step of its own; there's no generic adapter for
  this yet. Update: `shrink`/`redact`/`convert` all happen to use the same
  field name (`handle`) for their `{handle, ...opts}` input, so
  `src/op/reshape.ts`'s `wrapHandle`/`unwrapHandle` (registered as ordinary
  leaves, #118) bridge a bare `Handle` to/from that shape generically —
  `wrapHandle` only covers a target leaf whose other opts are all optional
  (e.g. `shrink`'s `stripMetadata`), since it can't supply a required opt like
  `convert`'s `to`; a leaf needing required opts merged in still needs its own
  reshape step. Update: a leaf spec's optional `params?: Record<string,
  unknown>` (`src/op/spec.ts`, #124) closes that last gap — `buildOp` shallow-
  merges it onto the piped object value right before the leaf's `fn` runs
  (guarding `__proto__`/`constructor`/`prototype`, same as `hydrate`/
  `fieldMerge`), so `convert`'s `to`/`from` can now ride along in a JSON spec.
  Gotcha for any future `OpSpec` field: `src/op/spec.ts`'s `buildOp` isn't the
  only place that shape is declared — `mcp.ts`'s `opSpecSchema` (a parallel
  zod schema, since MCP tool args need a JSON-schema-shaped input) silently
  strips any key it doesn't know about before `buildOp` ever sees it, and
  `http.ts`'s `POST /op/run` passes `body.spec` straight through untyped with
  no such schema. A new `OpSpec` field needs both `buildOp` *and*
  `opSpecSchema` updated together, or it works over HTTP and silently no-ops
  over MCP. Output-shape gotcha, mirroring the input one above: `shrink`/
  `redact`/`scrub` all wrap their result as `{handle, ...extra}`, but
  `convert` returns a bare `Handle` — so `unwrapHandle` belongs after
  `shrink`/`redact` in a pipe, never after `convert` (it would read a
  nonexistent `.handle` off the bare Handle and produce `undefined`). Update
  (#143): the `unwrapHandle`-after-`convert` mistake above is now caught at
  `buildOp` time, not just documented — `LEAF_SHAPES` (`src/op/registry.ts`)
  declares each built-in leaf's coarse input/output shape (`'handle'` |
  `'handle[]'` | `{ object: {...} }` | `'unknown'`), and a `pipe` spec's
  adjacent steps are checked against each other via `shapeCompatible`
  (`src/op/spec.ts`) before the tree is built. Only a `leaf` step's shape is
  known this way — `map`/`pipe`/`sink` steps, and any name absent from
  `LEAF_SHAPES` (a host-registered `extraLeaves` leaf, or a future built-in
  nobody added an entry for), read as `'unknown'` and are permissively
  treated as compatible with anything, so those mismatches still only
  surface at `runInline` time. A future built-in leaf needs its own
  `LEAF_SHAPES` entry to get build-time checking; nothing enforces that the
  table stays in sync with `LEAF_REGISTRY` beyond the test asserting their
  key sets match. Update (#161): an object field's shape can now also be
  `{ arrayObject: Record<string, 'handle' | 'unknown'> }` — pack's `files`
  input field and unpack's `entries` output field (each `Array<{name,
  handle, mtime}>`) are declared this way instead of collapsing to
  `'unknown'`, so a pipe step mismatching one of those fields (e.g. `unpack`
  feeding straight into `pack`, whose `files` key `unpack`'s `entries`-only
  output never has) is now a build-time error too. This only reaches one
  array level deep and doesn't help two leaves whose per-entry field is
  named differently (`entries` vs `files`) actually chain — that's #168's
  still-open design question, not solved here. Update (#168): closed via a
  new `mapField` op-tree tag (`src/op/{types,combinators}.ts`,
  `runtime/inline.ts`'s `case 'mapField'`), not a generic rename-leaf —
  `mapField(arrayField, elementField, innerOp, { concurrency, renameTo? })`
  runs `innerOp` over one named field of each array element and, in the same
  step, can rename the array field itself (`entries` -> `files`), since
  `mergeParams` (used for every other leaf's static params) deliberately
  skips array inputs and can't rename a field on one. `stepShape` derives
  `mapField`'s own declared boundary from its inner op's shape one level
  down, same trick `map` already uses one level up — see the `unpack ->
  mapField(renameTo: 'files') -> pack` tests in `test/op/spec.test.ts` for
  the shape this actually unblocks.
- Prototype-pollution-guard gotcha for any future `Object.create(null)`-based
  registry (`LEAF_REGISTRY`, and now `SINK_REGISTRY` in `src/op/sinks.ts`,
  #147): merging one into a live config/Caps object via object-literal spread
  (`{ ...REGISTRY, ...extra }`) silently discards the null-prototype
  protection — spread's `CreateDataProperty` semantics always produce a
  plain `Object.prototype`-based target, even when every source object is
  itself null-prototype. Build the merged object with `Object.assign(
  Object.create(null), REGISTRY, extra)` instead (see
  `src/adapters/op-run.ts`'s `caps.sinks` construction for the pattern).
- `cli.ts`'s `main()` gotcha: `program`/every subcommand (`archiveCmd`, etc.) are
  module-level Commander singletons, not rebuilt per call — a Commander `Option`
  that threw during one `main()` invocation (e.g. `archive create -m not-a-number`)
  leaves that option's *stale* parsed value sitting on the Command instance, and a
  later `main()` call to the *same* subcommand that omits the flag silently reads
  the previous call's bad value instead of `undefined`/its default. Reproduced with
  `archive create -m not-a-number` followed immediately by a clean `archive create`
  call with no `-m` — the second call still throws the first call's mtime error. A
  test (or any programmatic caller) invoking `main()` more than once against the
  same subcommand within one process must not rely on a prior failed call's flags
  being reset — build fixtures via the domain function directly instead of a second
  CLI invocation, the way `test/adapters/cli.test.ts`'s `archive extract` listing
  test does. This isn't limited to a call that *threw* — any successfully-parsed
  flag (`-o`, `--config`, a bare boolean like `--trace`, #228) sticks around the
  same way, on every other flag the subcommand declares, not just the one that
  happened to trigger an error first. Where a second `pipeline run`/etc. call in
  the same test file is unavoidable, explicitly re-pass every flag a prior test in
  that file has ever set on that subcommand (not just the one under test) rather
  than assuming an omitted flag reads as unset.
- Update to the OpSpec-validation footgun above (#208): `validateOpSpec`
  (`src/op/spec.ts`) collects every structural error `buildOp` would otherwise
  throw on one-at-a-time, but over the MCP surface specifically, `opSpecSchema`
  (the parallel zod schema) already range-checks `retries`/`concurrency` and
  rejects empty `steps`/`targets` arrays *before* a `validate_pipeline` call
  ever reaches the handler — those errors can never appear in `validate_pipeline`'s
  output, only in `POST /op/validate` (HTTP, no such schema) or `pipeline
  validate` (CLI, raw JSON). Only checks `opSpecSchema` doesn't already enforce
  (unknown leaf name, pipe-adjacency shape mismatches, reconcile
  `policy`/`defaultPolicy` values) are reachable through all three surfaces
  alike. A future validate-mode test written against the MCP tool needs a spec
  whose problem is one of those, not an out-of-range number, or it'll
  incorrectly observe `isError: true` from schema rejection instead of a
  `{ valid: false }` result.
- `otel.ts`'s exporters (#334/#338) are meant to be constructed once and
  reused across every concurrent `runInline` call reaching an adapter, but
  `TraceEvent.path` (#339) is only unique *within* one call — every call's
  own root is `path === ''`, so two calls overlapping on one exporter both
  produce a node-enter at that same path. `createOtelExporter`'s `open` map
  is keyed by path to a *stack* of entries (push on enter, pop on exit,
  traceId minted at root and inherited by children via the parent's
  still-open entry) rather than a single entry, so two overlapping runs no
  longer clobber each other — but this only resolves correctly when one
  run's whole window nests inside the other's (started later, finished
  earlier); two runs whose windows overlap without nesting and which visit
  the exact same relative path can still pop the wrong entry, since nothing
  in the `TraceEvent`/`GovernorEvent` stream carries a per-call identifier to
  disambiguate that case. A real fix needs a call-scoped id threaded through
  `runInline`/`traced()` (`src/runtime/inline.ts`) into every `TraceEvent`,
  which is a larger, deliberately out-of-scope change here — don't assume
  today's fix makes concurrent-run span attribution exact in the general
  case, only "no longer silently and unconditionally wrong." Update (#346):
  that call-scoped id now exists — `runInline`'s new trailing `runId`
  parameter defaults to `crypto.randomUUID()` on the *top-level* call only
  (every recursive call passes its already-minted `runId` straight through),
  and `TraceEvent` (`src/control/trace.ts`) carries it on every node-enter/
  node-exit. `createOtelExporter`'s `open` map is now keyed by `runId` first
  and `path` second (still a stack per `(runId, path)`, for the same-path-
  twice-in-one-run case, e.g. `sink.fanout(['a', 'a'])`), and `traceId` is
  derived directly from `runId` (dashes stripped — a v4 UUID's 32 hex digits
  are already a spec-valid 16-byte OTel trace id) instead of being minted at
  `path === ''` and inherited downward. This is now exact, not best-effort,
  for the `TraceEvent`/span side. `GovernorEvent` deliberately still stays
  name-keyed (`openByName` in `otel.ts`, unchanged) — #346 itself offered
  that as an acceptable fallback rather than threading `runId` through
  `GovernorEvent` too, which would touch every `onEvent` consumer's shape;
  a future change wanting exact governor-event attribution across concurrent
  runs still needs that larger, separate change. Update (#348): that larger
  change landed — `GovernorEvent` (`src/control/events.ts`) now carries an
  optional `runId` on every variant, same optionality pattern as `name`. The
  wrinkle `name`'s own convention doesn't have: `createGovernor`'s `tagged`
  wrapper (`src/control/governor.ts`) tags `name` once, at construction time,
  because a leaf's breaker/tokenBucket/concurrency are built once and shared
  across every `runInline` call that reaches that leaf — there is no single
  `runId` to bake in at that point. So `runId` instead rides in as a plain
  call argument threaded fresh through every gating method on each governor
  primitive (`CircuitBreaker.allow/onSuccess/onFailure`, `TokenBucket.take`,
  `Concurrency.release`) from `runGoverned`, which itself takes `runId` as a
  new optional trailing parameter (not folded into `RunGovernedOpts`,
  since `gOpts` is a caller-supplied object that can be reused across
  separate top-level `runInline` calls — mutating it with a per-call runId
  would reintroduce the exact cross-run ambiguity this issue exists to fix).
  `runInline`'s two `runGoverned` call sites (leaf, sink-target) pass their
  already-in-scope `runId` straight through. `otel.ts`'s `openByName` now
  tracks `{path, runId}` pairs per leaf name instead of bare paths, and its
  `onEvent` prefers the innermost entry whose `runId` matches the incoming
  event, falling back to the old "innermost span sharing this name"
  behavior only when the event carries no `runId` at all. Any future
  governor primitive (or `Concurrency` implementation) that emits a
  `GovernorEvent` needs to accept and stamp this same per-call `runId`
  argument to stay attributable — don't reach for `createGovernor`'s
  construction-time tagging for it, that pattern only fits values that are
  stable for a primitive's whole lifetime. Update (#366): the "same-path-
  twice-in-one-run" gap this note flagged above (`sink.fanout(['a', 'a'])`)
  is now closed for the `TraceEvent`/span side too — `TraceEvent` carries a
  `callId` (`src/control/trace.ts`), minted fresh per `traced()` invocation
  (`src/runtime/inline.ts`, a simple module-level counter, not
  `crypto.randomUUID()` — it only needs to be unique among calls
  concurrently sharing one `tag`/`name`/`path`/`runId`) and stamped on both
  a call's node-enter and its matching node-exit. `createOtelExporter`'s
  node-exit handler now finds and removes the specific stack entry whose
  `callId` matches, instead of unconditionally popping topmost — two
  duplicate-named concurrent spans can now exit in either order without
  cross-wiring one's timing/status onto the other. Any hand-crafted
  `TraceEvent` literal in a test (as opposed to one produced by actually
  running `traced()`) needs its own `callId` now too; `toEqual`-style exact
  object-literal assertions against `TraceEvent` arrays are brittle to this
  kind of field addition — check `test/runtime/inline-trace.test.ts`,
  `test/adapters/otel.test.ts`, and `test/adapters/op-run.test.ts` (the three
  files with literal `TraceEvent` shapes) whenever `TraceEvent`'s shape
  changes again. Update (#380): `runId` alone still can't disambiguate two
  duplicate-named leaves/sink-targets *within one run* that each
  independently emit their own `GovernorEvent` (both retry, say) — both land
  on `openByName`'s innermost entry, starving the outer one, since `runId`
  is identical for both. `GovernorEvent` now also carries `callId` (`src/
  control/events.ts`), and `runGoverned` (`src/control/governor.ts`) takes it
  as a second trailing parameter alongside `runId`, threading it into every
  gating method (`allow`/`onSuccess`/`onFailure`/`take`/`release`) the same
  way `runId` already was — `runInline`'s `traced()` wrapper now hands its
  own per-node `callId` into the `fn` it wraps (`fn: (callId: string) =>
  ...`) so the `'leaf'`/`'sink-target'` call sites can pass the identical id
  into `runGoverned`. `createOtelExporter`'s `onEvent` (`src/adapters/
  otel.ts`) now prefers an exact `callId` match before falling back to
  `runId`, then to innermost-by-name. Any future governor primitive needs to
  accept and stamp this same per-call `callId` (as a plain parameter, not
  construction-time tagging, same reasoning as `runId`) to stay exactly
  attributable when it can be invoked more than once concurrently for the
  same leaf name within one run.
- `src/op/plan.ts`'s `planOpSpec` (#361) is a third non-executing structural
  sibling to `validateOpSpec`/`describePipelineSchema` (`src/op/spec.ts`,
  `src/op/introspect.ts`) — its `maxRetryMultiplier` (Σ(retries+1)) sums over
  every `leaf` *regardless of `opts.kind`*, not just `'effect'` leaves: per
  the Governor convention note above, `LeafOpts.retries` applies to any leaf
  kind, so a `'pure'` leaf's retries still burn real attempts even though
  it's never gated by a breaker/bucket. Its capability-reachability fields
  (`usesLlm`/`llmLeaves`) read a new `LEAF_CAPS` table in `src/op/registry.ts`
  (parallel to `LEAF_SHAPES`, same by-hand sync-drift risk) rather than
  inventing shape-inference for it — `ask`/`sinks`/`cache` don't need a table
  since they're already visible directly on an `OpSpec` node's own shape.
  Fan-out width (`maxConcurrency`) only ever reports each `map`/`mapField`'s
  declared `concurrency` bound, never a total invocation count — how many
  items an array-shaped input actually holds at run time (e.g. past
  `unzip`'s `handle[]` output) is runtime data no structural pass can see, so
  `planOpSpec` deliberately refuses to estimate it rather than guess.
- Checkpoint convention (#390): `Caps.checkpoint` (`src/effects/types.ts`'s
  `Checkpoint` interface, optional like `ask`/`cache`) is consulted by
  `traced()` (`src/runtime/inline.ts`) for *every* node tag, not just `leaf`
  — unlike `memo`, this isn't a per-leaf opt-in flag, since resuming a
  crashed run needs the whole tree's progress, not one leaf's. A hit at
  `(runId, path)` short-circuits before `fn` runs at all (no governor call,
  no retries, no trace event) and returns the recorded value; a miss runs
  `fn` and persists a success under that key after. Since `path` already
  addresses individual `map`/`mapField` items and `sink` fanout targets, a
  caller resuming a crashed run with the *same* `runId` gets partial-fanout
  resume for free — only items/targets that never finished re-run. No
  `OpSpec`/`plan.ts` change accompanies this: eligibility isn't a per-node
  declared property the way `memo`/`ask`/`sinks` are, so there's nothing new
  for `validateOpSpec`/`planOpSpec` to report beyond the existing
  `nodeCount`. Only an in-memory `MemoryCheckpoint` ships here (inline/test
  use, keyed by a nested `Map<runId, Map<path, value>>` — no serialization,
  matching `MemoryCache`'s own scope); a future `sux`-side durable
  implementation owns persisting past process death. Known gap, not solved
  here: two *concurrent* nodes sharing one `path` at the same `runId` (e.g.
  `sink.fanout(['a', 'a'])`) can race on the same checkpoint key, since
  `Checkpoint.get`/`put` take `(runId, path)` only — not the `callId` that
  already disambiguates this exact case for `TraceEvent`/`GovernorEvent`
  (#366/#380). Follow the same incremental pattern those two took (ship
  `(runId, path)` first, add `callId` disambiguation later) rather than
  solving it preemptively.
