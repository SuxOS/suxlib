#!/usr/bin/env node
// CLI adapter: thin wrapper around src/domain/* that reads/writes local files.
// All actual logic lives in the pure domain functions — this file is I/O glue
// only. Generalized from sux-fileops's src/cli.ts during the suxlib absorption
// of sux-fileops.

import { Command } from 'commander'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { archiveCreate, archiveExtract, safeExtractPath, ARCHIVE_MIME, ARCHIVE_FORMATS, type ArchiveFormat } from '../domain/archive.js'
import { pdfShrink } from '../domain/pdf.js'
import { sanitizeImage, redactText, type RedactType } from '../domain/sanitize.js'
import { dispatchTransform, type Format } from '../domain/transform.js'

const program = new Command()
program.name('suxlib-fileops').description('Shared file-ops CLI: archive, sanitize, transform, pdf-shrink').version('0.0.0')

// ---------- archive ----------

const archiveCmd = program.command('archive').description('Create or extract zip/tar/gzip archives')

archiveCmd
  .command('create')
  .description('Pack one or more files into an archive')
  .argument('<files...>', 'files to pack')
  .requiredOption('-o, --output <path>', 'output archive path')
  .option('-f, --format <format>', 'zip | tar | gzip (gzip supports exactly one input file)', 'zip')
  .action((files: string[], opts: { output: string; format: string }) => {
    const format = opts.format as ArchiveFormat
    if (!ARCHIVE_FORMATS.includes(format)) throw new Error(`--format must be zip, tar, or gzip (got '${format}')`)
    const entries = files.map((f) => ({ name: basename(f), data: new Uint8Array(readFileSync(f)) }))
    const out = archiveCreate(format, entries)
    writeFileSync(opts.output, out)
    console.log(`wrote ${opts.output} (${out.length} bytes, ${ARCHIVE_MIME[format]}, ${entries.length} file(s))`)
  })

archiveCmd
  .command('extract')
  .description("Extract an archive's entries to a directory")
  .argument('<archive>', 'archive file to extract')
  .requiredOption('-o, --output <dir>', 'output directory')
  .option('-f, --format <format>', 'zip | tar | gzip (default: inferred from extension)')
  .action((archivePath: string, opts: { output: string; format?: string }) => {
    const format = (opts.format as ArchiveFormat) ?? inferArchiveFormat(archivePath)
    const bytes = new Uint8Array(readFileSync(archivePath))
    const { written, skipped } = extractArchiveTo(format, bytes, opts.output)
    console.log(`extracted ${written} entr${written === 1 ? 'y' : 'ies'} to ${opts.output}`)
    if (skipped.length) {
      console.log(`skipped ${skipped.length} non-regular entr${skipped.length === 1 ? 'y' : 'ies'} (symlink/hardlink/device): ${skipped.map((s) => `${s.name} (${s.typeflag})`).join(', ')}`)
    }
  })

function inferArchiveFormat(path: string): ArchiveFormat {
  if (path.endsWith('.zip')) return 'zip'
  if (path.endsWith('.tar')) return 'tar'
  if (path.endsWith('.gz') || path.endsWith('.gzip')) return 'gzip'
  throw new Error(`Cannot infer archive format from '${path}'. Pass --format explicitly.`)
}

/**
 * Extract an archive to `outputDir`, routing every entry through
 * domain/archive.ts's safeExtractPath (the zip-slip/tar-slip guard) before it
 * ever becomes a filesystem path. Exported (rather than inlined in the CLI
 * action) so it's directly unit-testable without shelling out to the CLI.
 */
export function extractArchiveTo(format: ArchiveFormat, bytes: Uint8Array, outputDir: string): { written: number; skipped: Array<{ name: string; typeflag: string }> } {
  const { entries, skipped = [] } = archiveExtract(format, bytes)
  mkdirSync(outputDir, { recursive: true })
  let written = 0
  for (const e of entries) {
    const dest = safeExtractPath(outputDir, e.name)
    // Directory entries (name ends in "/") carry no bytes and must become
    // directories, not files — otherwise a later child entry's mkdirSync
    // hits EEXIST against the zero-byte file we'd have written here. Guard on
    // the ORIGINAL name: safeExtractPath resolves away the trailing slash.
    if (e.name.endsWith('/')) {
      mkdirSync(dest, { recursive: true })
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, e.data)
    written++
  }
  return { written, skipped }
}

// ---------- pdf ----------

const pdfCmd = program.command('pdf').description('PDF operations')

pdfCmd
  .command('shrink')
  .description('Shrink a PDF (object streams + metadata strip)')
  .argument('<file>', 'input PDF')
  .requiredOption('-o, --output <path>', 'output PDF path')
  .option('--keep-metadata', "don't strip document metadata", false)
  .action(async (file: string, opts: { output: string; keepMetadata: boolean }) => {
    const input = new Uint8Array(readFileSync(file))
    const result = await pdfShrink(input, { stripMetadata: !opts.keepMetadata })
    writeFileSync(opts.output, result.bytes)
    console.log(`wrote ${opts.output}: ${result.inputBytes} -> ${result.outputBytes} bytes (${result.savedPct}% saved)`)
  })

// ---------- sanitize ----------

const sanitizeCmd = program.command('sanitize').description('Strip metadata / redact PII')

sanitizeCmd
  .command('image')
  .description('Strip EXIF/metadata from a JPEG or PNG')
  .argument('<file>', 'input image')
  .requiredOption('-o, --output <path>', 'output image path')
  .action((file: string, opts: { output: string }) => {
    const input = new Uint8Array(readFileSync(file))
    const result = sanitizeImage(input)
    writeFileSync(opts.output, result.bytes)
    console.log(`wrote ${opts.output}: stripped ${result.strippedBytes} bytes of ${result.kind} metadata`)
  })

sanitizeCmd
  .command('text')
  .description('Redact PII from text (reads a file or stdin)')
  .argument('[file]', 'input text file (default: stdin)')
  .option('-t, --types <types>', 'comma-separated subset: email,phone,ssn,credit_card,ip')
  .action((file: string | undefined, opts: { types?: string }) => {
    const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
    const types = opts.types ? (opts.types.split(',').map((t) => t.trim()) as RedactType[]) : undefined
    const result = redactText(text, types)
    process.stdout.write(result.redacted + '\n')
    console.error(`[redacted] ${JSON.stringify(result.counts)}`)
  })

// ---------- transform ----------

program
  .command('transform')
  .description('Convert between json/yaml/csv/xml/markdown/html (reads a file or stdin, writes stdout)')
  .argument('[file]', 'input file (default: stdin)')
  .requiredOption('--to <format>', 'json | yaml | csv | xml | markdown | html')
  .option('--from <format>', 'json | yaml | csv | xml | markdown | html | auto', 'auto')
  .option('--delimiter <char>', 'CSV delimiter', ',')
  .action((file: string | undefined, opts: { to: Format; from: string; delimiter: string }) => {
    const data = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
    process.stdout.write(dispatchTransform(data, opts.from as Format | 'auto', opts.to, opts.delimiter))
  })

/** Re-exported for tests: the actual dispatch logic is `dispatchTransform` in
 * src/domain/transform.ts, shared verbatim by the CLI, HTTP, and MCP adapters —
 * this alias just keeps tests importing `transform` from here working. */
export const transform = dispatchTransform

/** Entry point called by bin/fileops.mjs. Kept separate from module load so
 * importing `transform` (e.g. from tests) never triggers argv parsing. */
export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exitCode = 1
  }
}
