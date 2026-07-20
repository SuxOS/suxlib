# @suxos/lib

SuxOS's shared, dependency-light **pure core + adapters** library — the home of the
**op engine** (`op`/`map`/`mapField`/`reconcile`/`pipe`/`sink`/`ask`/`catch`/`saga`, the
`runInline` graduated runtime) and of `sux-fileops`'s absorbed domain logic
(archive/pdf/sanitize/transform), exposed identically over CLI, HTTP, and MCP.

## Install

Source-distributed, no publish step: `exports["."]` in `package.json` points straight
at `src/index.ts` — there is no `dist/` and nothing is published to npm. Consumers
depend on this repo directly and let their own bundler (esbuild via `wrangler`, or
`tsx`) compile the TypeScript on the fly:

```json
{ "dependencies": { "@suxos/lib": "file:../suxlib" } }
```

or, when not checked out as a sibling directory:

```json
{ "dependencies": { "@suxos/lib": "github:SuxOS/suxlib" } }
```

## Public surface

`package.json`'s `exports` map splits the library into a pure core and three optional
adapters, so a consumer that only wants the op engine or domain functions doesn't pull
in adapter-only dependencies (`commander`, `zod`, `@modelcontextprotocol/sdk`):

| Subpath            | What it is                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `@suxos/lib`        | Pure core: op engine + domain functions. No CLI/HTTP/MCP dependencies.  |
| `@suxos/lib/adapters/cli` | Commander-based CLI (`bin/suxlib-fileops`)                       |
| `@suxos/lib/adapters/http` | Cloudflare Worker `fetch` handler (JSON in/out, base64 for bytes) |
| `@suxos/lib/adapters/mcp`  | `registerFileopsTools(server)` for `@modelcontextprotocol/sdk`   |

### Op engine

Typed op-tree combinators (`src/op/*`), content-addressed `Handle`/`Store` (`src/handles/*`),
reliability primitives — AIMD concurrency, full-jitter backoff, idempotency keys, token
bucket, circuit breaker (`src/control/*`) — capability interfaces (`src/effects/*`), and
`runInline`, the in-process runtime for executing an `Op` tree (`src/runtime/*`). This
repo stays platform-agnostic; the durable (Cloudflare Workflows) runtime lives in the
`sux` Worker, since it's binding-specific.

### Domain functions

Pure functions of the shape `(Uint8Array | string, opts) => output` — no `fetch`, no
ambient `fs`, no KV (`src/domain/*`):

- **archive** (`archive.ts`) — create/extract zip, tar, gzip; zip-slip-safe path
  resolution; zip/gzip bomb guards.
- **sanitize** (`sanitize.ts`) — strip image metadata, redact PII from text.
- **transform** (`transform.ts`) — convert between json/yaml/csv/xml/markdown/html.
- **pdf** (`pdf.ts`) — shrink a PDF, count its pages.
- **text** (`text.ts`) — PDF-to-markdown and summarize leaves (these call an injected
  `Llm` capability, so they're effect leaves rather than pure functions).

## Adapters: one surface, three transports

Each of `src/adapters/{cli,http,mcp}.ts` is thin I/O glue over `src/domain/*` — no
logic duplicated across CLI/HTTP/MCP; every adapter calls the same domain functions
(`dispatchTransform` for transform, `archiveCreate`/`archiveExtract` for archive, and so
on) and only differs in how it reads input and shapes output:

- **CLI** (`bin/suxlib-fileops`) — reads/writes local files; shells out to `tsx` since
  this package has no build step of its own.
- **HTTP** — a Cloudflare Worker `fetch` handler; JSON in with base64-encoded bytes,
  JSON out. Open by default — set the `FILEOPS_AUTH_TOKEN` secret to require a bearer
  token, and put it behind an upstream gate (Cloudflare Access, mTLS, a private route)
  if you do deploy it open.
- **MCP** — `registerFileopsTools(server, { allow? })` registers every domain function
  as an MCP tool (or a subset via `allow`) on an `@modelcontextprotocol/sdk` server.

### Composable pipelines: `POST /op/run` and the `run_pipeline` MCP tool

Beyond one-shot single-leaf calls, all three adapters also expose the op engine
itself: a JSON `{ tag: 'leaf' | 'pipe' | 'map' | 'mapField' | 'sink' | 'reconcile' | 'catch' | 'ask' | 'saga', ... }`
spec (`src/op/spec.ts`) describes a pipeline over the leaves in `src/op/registry.ts`'s
`LEAF_REGISTRY` (`pack`/`unpack`/`unzip`/`shrink`/`pageCount`/`redact`/`scrub`/
`convert`/`extract`/`summarize`/`wrapHandle`/`unwrapHandle`/`stamp`), which gets built into a
real `Op` tree and run via `runInline` — a multi-step job (e.g. unzip a bundle,
transform each entry) runs as one call instead of several round trips. A `mapField`
step runs an inner op over one named field of each element of a named array field,
reattaching the rest of each element untouched and optionally renaming the array field
itself — e.g. `unpack -> mapField(arrayField: 'entries', elementField: 'handle',
renameTo: 'files') -> pack` transforms every archive entry's Handle in between while
bridging `unpack`'s `entries` output into `pack`'s `files` input, something `map` alone
can't do since it only replaces a whole array element. A `sink` step names its
target(s) by string, resolved against `Caps.sinks`/`OpRunOpts.sinks` at run time, and a
`reconcile` step needs only `caps.store`, which every adapter call already supplies —
neither needs a live capability inside the spec itself, so both are spec-expressible.
An `ask` step builds a real `ask()` op node directly from the spec (`prompt`,
`timeout`, `onTimeout`); with no host-supplied `Ask` capability, `runInline`
degrades gracefully — it throws on `onTimeout: 'fail'` or proceeds with the
piped value on `'proceed'`. A
`catch` step runs its `try` branch and, on any thrown error, re-runs its
`catch` branch against the original input instead of aborting the whole
pipe — e.g. `{ tag: 'catch', try: <primary sink>, catch: <fallback sink> }`.
A `saga` step (`{ tag: 'saga', steps: [{ op, compensate? }, ...] }`) runs its
steps in order like `pipe`, but if a later step throws, runs every
already-succeeded step's own `compensate` (if it declared one) in reverse
order against that step's own output before the original error propagates —
e.g. deleting a completed upload if a downstream step then fails. An abort
skips compensation entirely, same as `catch` skips its fallback on abort.
Handle-shaped values thread
through as `{ $handle: true, base64, type? }` on the way in and `{ base64, type, size }`
on the way out. `POST /op/run` and the `run_pipeline` MCP tool take this JSON directly;
`suxlib-fileops pipeline run <spec-file>` takes the same `{ spec, input }` shape from a
local JSON file, resolving any input value shaped `{ "$file": "<path>", "type"?:
"<mime>" }` off disk into a Handle ref, and (with `-o <dir>`) writing dehydrated Handle
results back to files instead of inlining base64 in the printed JSON.

To discover what a spec can currently contain — registered leaf names and their
declared input/output shapes, sink target names, reconcile modes, and field-merge
policies — without reading source, all three adapters also expose a read-only schema
query: `GET /op/schema`, the `describe_pipeline` MCP tool, and `suxlib-fileops pipeline
describe`. Each merges in any host-registered `opRunLeaves`/`opRunSinks` alongside the
built-in registry, the same way `POST /op/run`/`run_pipeline`/`pipeline run` do.

To check a spec for structural problems (unknown leaf names, out-of-range
retries/concurrency, malformed `ask`/`reconcile`/`mapField` fields, mismatched
pipe-adjacency shapes, ...) without running it, all three adapters also expose a
non-executing validate: `POST /op/validate`, the `validate_pipeline` MCP tool, and
`suxlib-fileops pipeline validate <spec-file>`. Unlike `buildOp` (which throws on the
first problem it finds), validate walks the whole spec and returns every error in one
pass — `{ valid, errors: [{ path, message }] }` — so a caller composing a nontrivial
spec doesn't need one round-trip per mistake.

## Development

```sh
npm test        # vitest run
npm run build    # tsc --noEmit (strict mode, type-check only — no dist/ output)
```

Tests mirror source under `test/**` (one test file per source file). Both commands must
pass before merging — see `.github/workflows/ci.yml` and `CLAUDE.md` for the full
contributor workflow.
