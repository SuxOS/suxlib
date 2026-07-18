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
import { LEAF_REGISTRY } from '../op/registry.js'
import type { OpSpec } from '../op/spec.js'
import type { Governor } from '../op/types.js'
import type { Cache, Store } from '../effects/types.js'

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

const opSpecSchema: z.ZodType<OpSpec> = z.lazy(() => z.union([
  z.object({ tag: z.literal('leaf'), name: z.string(), opts: opSpecLeafOptsSchema }),
  z.object({ tag: z.literal('pipe'), steps: z.array(opSpecSchema).min(1) }),
  z.object({ tag: z.literal('map'), op: opSpecSchema, concurrency: z.number().int().min(1).max(32) }),
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
   * Persistent, host-built governors (keyed by leaf name, see
   * createGovernor in src/control/governor.ts) and/or cache, threaded
   * through to every run_pipeline call's Caps (op-run.ts's OpRunOpts) so a
   * spec's leaf opts.retries actually gets breaker/token-bucket/concurrency
   * gating and opts.memo actually memoizes, instead of both silently
   * degrading to a no-op. Build these once per server instance, not per
   * call, so their state (breaker trip counts, bucket levels, cache
   * entries) persists across run_pipeline invocations. `store` matters for
   * `cache` specifically: a memoized leaf's cached output frequently embeds
   * a Handle, only resolvable against the Store it was written to, so
   * `cache` only survives across calls when `store` is supplied too (see
   * op-run.ts's OpRunOpts doc comment).
   */
  governors?: Record<string, Governor>
  cache?: Cache
  store?: Store
}

/** Register every fileops tool on an MCP server instance, or a subset via `opts.allow`. */
export function registerFileopsTools(server: McpServer, opts: RegisterFileopsToolsOptions = {}): void {
  const allow = opts.allow ? new Set(opts.allow) : null
  const enabled = (name: string) => !allow || allow.has(name)

  if (enabled('archive_create')) {
    server.registerTool(
      'archive_create',
      {
        description: 'Pack one or more files into a zip, tar, or gzip archive.',
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
        description: 'Extract a zip, tar, or gzip archive into its entries.',
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
    server.registerTool(
      'run_pipeline',
      {
        description:
          `Run a JSON-described op-tree pipeline (leaf/pipe/map) over the op engine's registered leaves ` +
          `(${Object.keys(LEAF_REGISTRY).join(', ')}), instead of calling one tool per step. ` +
          `Handle-shaped values in \`input\`/the result are marshalled as { $handle: true, base64, type } / { base64, type, size }.`,
        inputSchema: {
          spec: opSpecSchema,
          input: z.unknown(),
        },
      },
      async ({ spec, input }) => textResult(await runOpSpec({ spec, input }, { governors: opts.governors, cache: opts.cache, store: opts.store })),
    )
  }
}
