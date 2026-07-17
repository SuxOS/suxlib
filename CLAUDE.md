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
- **Integrate via PR.** PR bodies end with:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- **Before merging anything substantial: run `/code-review`.** Findings-fix rounds
  before merge are the norm, not the exception.
- **Self-isolate work in a git worktree**: `git worktree add .scratch-worktrees/<slug>
  -b <type>/<slug>` — don't work directly on a checked-out branch that another
  session/task might also be touching.

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
  same awareness.
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
  same two methods with persisted state to actually close the gap.
