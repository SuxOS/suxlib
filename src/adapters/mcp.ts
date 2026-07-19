// MCP adapter: registers the domain functions as MCP tools, so this library
// can be dropped into any MCP server. Thin — all logic lives in src/domain/*;
// this file only does schema declaration + base64 marshalling. Generalized
// from sux-fileops's src/mcp.ts during the suxlib absorption of sux-fileops.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { archiveCreate, archiveExtract, ARCHIVE_MIME, ARCHIVE_FORMATS, MAX_ENTRIES, MAX_UNPACK_BYTES, type ArchiveFile, type ArchiveFormat } from '../domain/archive.js'
import { pdfShrink, pdfPageCount } from '../domain/pdf.js'
import { sanitizeImage, redactText, REDACT_TYPES } from '../domain/sanitize.js'
import { dispatchTransform, TRANSFORM_FORMATS, type Format } from '../domain/transform.js'
import { b64ToBytes, bytesToB64 } from './base64.js'
import { runOpSpec } from './op-run.js'
import { mergeLeaves } from '../op/registry.js'
import { SINK_REGISTRY } from '../op/sinks.js'
import { FIELD_POLICIES, type OpSpec } from '../op/spec.js'
import { describePipelineSchema } from '../op/introspect.js'
import type { Governor, SinkTarget, LeafFn } from '../op/types.js'
import type { Cache, Store, Llm } from '../effects/types.js'

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] }
}

// Recursive JSON schema for an op-tree spec (src/op/spec.ts) -- z.lazy defers
// building the schema for `steps`/`op` until it's actually validated, which is
// what makes a self-referential shape like this expressible in zod at all.
const opSpecLeafOptsSchema = z.object({
  retries: z.number().int().min(0).max(5).optional(),
  heavy: z.boolean().optional(),
  memo: z.boolean().optional(),
  kind: z.enum(['pure', 'effect']).optional(),
}).optional()

// Derived from spec.ts's FIELD_POLICIES (not a hand-duplicated literal array)
// so this schema can't silently drift from what buildOp actually validates --
// the concrete example CLAUDE.md's OpSpec-validation footgun note calls out (#187).
const fieldPolicySchema = z.enum(FIELD_POLICIES)

// Mirrors src/op/reconcile.ts's ReconcileOpts discriminated union; buildOp
// (src/op/spec.ts) re-validates mode/defaultPolicy/policy itself, so this
// schema only needs to stop unknown shapes being silently stripped before it
// gets there -- same reasoning as `params` below.
const reconcileOptsSchema = z.union([
  z.object({ mode: z.literal('faithful-union') }),
  z.object({ mode: z.literal('last-write-wins') }),
  z.object({ mode: z.literal('field-merge'), defaultPolicy: fieldPolicySchema.optional(), policy: z.record(z.string(), fieldPolicySchema).optional() }),
])

const opSpecSchema: z.ZodType<OpSpec> = z.lazy(() => z.union([
  // record(z.unknown()), not a stricter value schema: `params` is shallow-merged
  // as-is onto whatever the piped value is (buildOp/mergeParams, src/op/spec.ts)
  // and its shape is entirely leaf-specific (convert's `to`/`from` are strings,
  // a future leaf's param could be anything JSON-shaped) -- zod only needs to
  // stop this key from being silently stripped before it reaches buildOp.
  z.object({ tag: z.literal('leaf'), name: z.string(), opts: opSpecLeafOptsSchema, params: z.record(z.string(), z.unknown()).optional() }),
  z.object({ tag: z.literal('pipe'), steps: z.array(opSpecSchema).min(1) }),
  z.object({ tag: z.literal('map'), op: opSpecSchema, concurrency: z.number().int().min(1).max(32) }),
  z.object({
    tag: z.literal('mapField'),
    arrayField: z.string(),
    elementField: z.string(),
    op: opSpecSchema,
    concurrency: z.number().int().min(1).max(32),
    renameTo: z.string().optional(),
  }),
  z.object({ tag: z.literal('sink'), targets: z.array(z.string()).min(1) }),
  z.object({ tag: z.literal('reconcile'), opts: reconcileOptsSchema }),
  z.object({ tag: z.literal('catch'), try: opSpecSchema, catch: opSpecSchema }),
  z.object({ tag: z.literal('ask'), prompt: z.string(), timeout: z.string(), onTimeout: z.enum(['proceed', 'fail']) }),
]))

export type RegisterFileopsToolsOptions = {
  /**
   * Restrict registration to these tool names (e.g. "archive_create"). Every
   * tool is registered when omitted — hosts that want to expose a subset
   * (or gate registration on their own permission check) pass this instead
   * of calling registerFileopsTools unconditionally.
   */
  allow?: string[]
  /**
   * Long-lived governors (createGovernor(name, spec) per LEAF_REGISTRY leaf)
   * and/or Cache/Store the host wants `run_pipeline` calls to share, so
   * op-engine pipelines triggered through this MCP server actually get
   * persistent breaker/token-bucket/concurrency gating and memoization
   * (#119) instead of a fresh governors-free Caps per call. Omitted entirely
   * still works — retries still apply, the rest just no-ops per
   * runGoverned's own degrade-gracefully pattern. Passing `opRunCache`
   * without `opRunStore` is a footgun (see op-run.ts's OpRunOpts doc) — a
   * memoized leaf's Handle-shaped result won't resolve against a fresh
   * per-call MemoryStore on a later cache hit.
   */
  opRunGovernors?: Record<string, Governor>
  opRunCache?: Cache
  opRunStore?: Store
  /**
   * Host-supplied SinkTarget instances a `run_pipeline` spec's `sink`/
   * `sink.fanout` targets can name, merged alongside SINK_REGISTRY's
   * built-in `store` target (op/sinks.ts). Omitted entirely still leaves
   * `store` reachable — `sink`/`ask`/`reconcile` used to be 100% dead weight
   * from every adapter's perspective (#147); this is what makes the `sink`
   * half of that reachable over MCP.
   */
  opRunSinks?: Record<string, SinkTarget>
  /**
   * A host-supplied Llm implementation (real network calls to whatever model
   * backs it are the host's responsibility — this repo stays
   * dependency-light and never constructs one itself), so `run_pipeline` can
   * actually exercise text.ts's `extract`/`summarize` leaves (registered in
   * LEAF_REGISTRY). Omitted entirely, those two leaves throw instead of
   * silently running with a do-nothing capability (see op-run.ts's
   * OpRunOpts doc).
   */
  opRunLlm?: Llm
  /**
   * Host-registered LeafFns merged onto LEAF_REGISTRY (op/registry.ts's
   * `mergeLeaves`, same host-overrides-built-in order as `opRunSinks`), so a
   * `run_pipeline` spec's `leaf.name` can resolve against logic this library
   * never shipped. Omitted entirely still resolves every built-in registry
   * leaf as before.
   */
  opRunLeaves?: Record<string, LeafFn>
}

/** Register every fileops tool on an MCP server instance, or a subset via `opts.allow`. */
export function registerFileopsTools(server: McpServer, opts: RegisterFileopsToolsOptions = {}): void {
  const allow = opts.allow ? new Set(opts.allow) : null
  const enabled = (name: string) => !allow || allow.has(name)

  if (enabled('archive_create')) {
    server.registerTool(
      'archive_create',
      {
        description: 'Pack one or more files into a zip, tar, gzip, or tar.gz archive.',
        inputSchema: {
          format: z.enum(ARCHIVE_FORMATS).default('zip'),
          files: z.array(z.object({ name: z.string(), base64: z.string(), mtime: z.number().optional() })).min(1).max(MAX_ENTRIES),
        },
      },
      async ({ format, files }) => {
        const fmt = format as ArchiveFormat
        // Decode incrementally and check the running total against
        // archiveCreate's own bomb guard as we go, rather than decoding every
        // file up front — otherwise a full array of near-cap files forces
        // the entire aggregate decode before archiveCreate ever gets a
        // chance to reject it.
        const entries: ArchiveFile[] = []
        let totalBytes = 0
        for (const f of files) {
          const data = b64ToBytes(f.base64)
          totalBytes += data.length
          if (totalBytes > MAX_UNPACK_BYTES) throw new Error(`archive input totals more than ${MAX_UNPACK_BYTES} bytes (bomb guard).`)
          entries.push({ name: f.name, data, mtime: f.mtime })
        }
        const out = archiveCreate(fmt, entries)
        return textResult({ format: fmt, mime: ARCHIVE_MIME[fmt], bytes: out.length, base64: bytesToB64(out) })
      },
    )
  }

  if (enabled('archive_extract')) {
    server.registerTool(
      'archive_extract',
      {
        description: 'Extract a zip, tar, gzip, or tar.gz archive into its entries.',
        inputSchema: {
          format: z.enum(ARCHIVE_FORMATS).default('zip'),
          base64: z.string(),
        },
      },
      async ({ format, base64 }) => {
        const { entries, skipped } = archiveExtract(format as ArchiveFormat, b64ToBytes(base64))
        return textResult({
          entries: entries.map((e) => ({ name: e.name, bytes: e.bytes, text: e.text, truncated: e.truncated, mtime: e.mtime, base64: bytesToB64(e.data) })),
          ...(skipped ? { skipped } : {}),
        })
      },
    )
  }

  if (enabled('pdf_shrink')) {
    server.registerTool(
      'pdf_shrink',
      {
        description: 'Shrink a PDF: re-save with object streams and (by default) strip document metadata.',
        inputSchema: {
          base64: z.string(),
          keepMetadata: z.boolean().default(false),
        },
      },
      async ({ base64, keepMetadata }) => {
        const result = await pdfShrink(b64ToBytes(base64), { stripMetadata: !keepMetadata })
        return textResult({ mime: 'application/pdf', inputBytes: result.inputBytes, outputBytes: result.outputBytes, savedPct: result.savedPct, base64: bytesToB64(result.bytes) })
      },
    )
  }

  if (enabled('pdf_page_count')) {
    server.registerTool(
      'pdf_page_count',
      {
        description: "Report a PDF's page count.",
        inputSchema: { base64: z.string() },
      },
      async ({ base64 }) => {
        const pageCount = await pdfPageCount(b64ToBytes(base64))
        return textResult({ pageCount })
      },
    )
  }

  if (enabled('sanitize_image')) {
    server.registerTool(
      'sanitize_image',
      {
        description: 'Strip embedded EXIF/metadata from a JPEG or PNG image.',
        inputSchema: { base64: z.string() },
      },
      async ({ base64 }) => {
        const result = sanitizeImage(b64ToBytes(base64))
        return textResult({ kind: result.kind, strippedBytes: result.strippedBytes, base64: bytesToB64(result.bytes) })
      },
    )
  }

  if (enabled('sanitize_text')) {
    server.registerTool(
      'sanitize_text',
      {
        description: 'Redact PII (email, phone, ssn, credit_card, ip) from text.',
        inputSchema: {
          text: z.string(),
          types: z.array(z.enum(REDACT_TYPES)).optional(),
        },
      },
      async ({ text, types }) => textResult(redactText(text, types)),
    )
  }

  if (enabled('transform')) {
    server.registerTool(
      'transform',
      {
        description: 'Convert between json, yaml, csv, xml, markdown, and html.',
        inputSchema: {
          data: z.string(),
          from: z.enum([...TRANSFORM_FORMATS, 'auto']).default('auto'),
          to: z.enum(TRANSFORM_FORMATS),
          delimiter: z.string().default(','),
        },
      },
      async ({ data, from, to, delimiter }) => textResult({ data: dispatchTransform(data, from as Format | 'auto', to as Format, delimiter) }),
    )
  }

  if (enabled('run_pipeline')) {
    // mergeLeaves(opts.opRunLeaves), not the bare LEAF_REGISTRY: this help
    // text needs to name every leaf a `run_pipeline` spec's `leaf.name` can
    // actually resolve against, including host-registered ones (#158) -- and
    // unlike cli.ts's `pipeline run` (whose description is built at module
    // load, before argv/--config are known), `opts` is already in scope here
    // at registerFileopsTools call time, so this can just read it directly.
    // Same reasoning applies to sink targets: merge opts.opRunSinks onto
    // SINK_REGISTRY (host-overrides-built-in, same order as op-run.ts's own
    // merge) rather than naming only the bare built-in registry.
    const leafNames = Object.keys(mergeLeaves(opts.opRunLeaves))
    const sinkNames = Object.keys(Object.assign(Object.create(null), SINK_REGISTRY, opts.opRunSinks))
    server.registerTool(
      'run_pipeline',
      {
        description:
          `Run a JSON-described op-tree pipeline (leaf/pipe/map/mapField/sink/catch) over the op engine's registered leaves ` +
          `(${leafNames.join(', ')}) and sink targets (${sinkNames.join(', ')}), ` +
          `instead of calling one tool per step. ` +
          `Handle-shaped values in \`input\`/the result are marshalled as { $handle: true, base64, type } / { base64, type, size }.`,
        inputSchema: {
          spec: opSpecSchema,
          input: z.unknown(),
        },
      },
      async ({ spec, input }) => textResult(await runOpSpec({ spec, input }, { governors: opts.opRunGovernors, cache: opts.opRunCache, store: opts.opRunStore, sinks: opts.opRunSinks, llm: opts.opRunLlm, leaves: opts.opRunLeaves })),
    )
  }

  if (enabled('describe_pipeline')) {
    server.registerTool(
      'describe_pipeline',
      {
        description:
          'Describe every leaf/sink/reconcile option a `run_pipeline` OpSpec can currently use: ' +
          'each registered leaf\'s declared input/output shape, sink target names, reconcile modes, and field-merge policies.',
        inputSchema: {},
      },
      async () => textResult(describePipelineSchema(opts.opRunLeaves, opts.opRunSinks)),
    )
  }
}
