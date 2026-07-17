// MCP adapter: registers the domain functions as MCP tools, so this library
// can be dropped into any MCP server. Thin — all logic lives in src/domain/*;
// this file only does schema declaration + base64 marshalling. Generalized
// from sux-fileops's src/mcp.ts during the suxlib absorption of sux-fileops.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { archiveCreate, archiveExtract, ARCHIVE_MIME, ARCHIVE_FORMATS, MAX_ENTRIES, MAX_UNPACK_BYTES, type ArchiveFile, type ArchiveFormat } from '../domain/archive.js'
import { pdfShrink } from '../domain/pdf.js'
import { sanitizeImage, redactText, REDACT_TYPES } from '../domain/sanitize.js'
import { dispatchTransform, type Format } from '../domain/transform.js'
import { b64ToBytes, bytesToB64 } from './base64.js'

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] }
}

const TRANSFORM_FORMATS = ['json', 'yaml', 'csv', 'xml', 'markdown', 'html'] as const

export type RegisterFileopsToolsOptions = {
  /**
   * Restrict registration to these tool names (e.g. "archive_create"). Every
   * tool is registered when omitted — hosts that want to expose a subset
   * (or gate registration on their own permission check) pass this instead
   * of calling registerFileopsTools unconditionally.
   */
  allow?: string[]
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
          files: z.array(z.object({ name: z.string(), base64: z.string() })).min(1).max(MAX_ENTRIES),
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
          entries.push({ name: f.name, data })
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
          entries: entries.map((e) => ({ name: e.name, bytes: e.bytes, text: e.text, truncated: e.truncated, base64: bytesToB64(e.data) })),
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
}
