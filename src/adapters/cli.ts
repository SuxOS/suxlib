#!/usr/bin/env node
// CLI adapter: thin wrapper around src/domain/* that reads/writes local files.
// All actual logic lives in the pure domain functions — this file is I/O glue
// only. Generalized from sux-fileops's src/cli.ts during the suxlib absorption
// of sux-fileops.

import { Command } from 'commander'
import { readFileSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { archiveCreate, archiveExtract, safeExtractPath, ARCHIVE_MIME, ARCHIVE_FORMATS, type ArchiveFormat } from '../domain/archive.js'
import { pdfShrink, pdfPageCount } from '../domain/pdf.js'
import { sanitizeImage, redactText, REDACT_TYPES, type RedactType } from '../domain/sanitize.js'
import { dispatchTransform, type Format } from '../domain/transform.js'
import { runOpSpec, type OpRunOpts } from './op-run.js'
import { mergeLeaves } from '../op/registry.js'
import { validateOpSpec, type OpSpec } from '../op/spec.js'
import { describePipelineSchema } from '../op/introspect.js'
import { planOpSpec } from '../op/plan.js'
import { b64ToBytes, bytesToB64 } from './base64.js'

const program = new Command()

// Set by main() before parsing, read by the `pipeline run` action below.
// commander's .action() closures are built once at module load time, before
// main()'s caller has a chance to supply anything -- a module-level slot is
// how a programmatic caller of main() (unlike bin/fileops.mjs, which has no
// way to construct a live Llm/Store/Cache object from argv) hands runOpSpec
// the same host-configurable capabilities HTTP's Env / MCP's
// RegisterFileopsToolsOptions already offer.
let cliOpRunOpts: OpRunOpts = {}
program.name('suxlib-fileops').description('Shared file-ops CLI: archive, sanitize, transform, pdf-shrink').version('0.0.0')

// ---------- archive ----------

const archiveCmd = program.command('archive').description('Create or extract zip/tar/gzip/tar.gz archives')

archiveCmd
  .command('create')
  .description('Pack one or more files into an archive')
  .argument('<files...>', 'files to pack')
  .requiredOption('-o, --output <path>', 'output archive path')
  .option('-f, --format <format>', 'zip | tar | gzip | tar.gz (gzip supports exactly one input file)', 'zip')
  .option('-m, --mtime <epoch-ms-or-pairs>', "override packed file mtime(s): a bare epoch-ms value applies to every file, or 'name=epoch-ms[,name=epoch-ms...]' to override specific files by their basename (default: each input file's own filesystem mtime)")
  .action((files: string[], opts: { output: string; format: string; mtime?: string }) => {
    const format = opts.format as ArchiveFormat
    if (!ARCHIVE_FORMATS.includes(format)) throw new Error(`--format must be zip, tar, gzip, or tar.gz (got '${format}')`)
    let mtimeOverride: number | undefined
    let perFileMtime: Map<string, number> | undefined
    if (opts.mtime !== undefined) {
      if (opts.mtime.includes('=')) {
        perFileMtime = new Map()
        for (const pair of opts.mtime.split(',')) {
          const eq = pair.indexOf('=')
          const name = eq === -1 ? '' : pair.slice(0, eq)
          const v = Number(pair.slice(eq + 1))
          if (!name || Number.isNaN(v)) throw new Error(`--mtime per-file entries must be 'name=epoch-ms' with a numeric value (got '${pair}')`)
          perFileMtime.set(name, v)
        }
        const basenames = new Set(files.map((f) => basename(f)))
        for (const name of perFileMtime.keys()) {
          if (!basenames.has(name)) throw new Error(`--mtime references unknown file '${name}' (packed files: ${[...basenames].join(', ')})`)
        }
      } else {
        mtimeOverride = Number(opts.mtime)
        if (Number.isNaN(mtimeOverride)) throw new Error(`--mtime must be a numeric epoch-ms value or 'name=epoch-ms[,name=epoch-ms...]' (got '${opts.mtime}')`)
      }
    }
    const entries = files.map((f) => {
      const name = basename(f)
      const mtime = perFileMtime?.get(name) ?? mtimeOverride ?? statSync(f).mtimeMs
      return { name, data: new Uint8Array(readFileSync(f)), mtime }
    })
    const out = archiveCreate(format, entries)
    writeFileSync(opts.output, out)
    console.log(`wrote ${opts.output} (${out.length} bytes, ${ARCHIVE_MIME[format]}, ${entries.length} file(s))`)
  })

archiveCmd
  .command('extract')
  .description("Extract an archive's entries to a directory, or list them without writing to disk when -o is omitted")
  .argument('<archive>', 'archive file to extract')
  .option('-o, --output <dir>', 'output directory; when omitted, prints each entry (name/bytes/text/base64/mtime) as JSON to stdout instead of extracting')
  .option('-f, --format <format>', 'zip | tar | gzip | tar.gz (default: inferred from extension)')
  .action((archivePath: string, opts: { output?: string; format?: string }) => {
    const format = (opts.format as ArchiveFormat) ?? inferArchiveFormat(archivePath)
    if (!ARCHIVE_FORMATS.includes(format)) throw new Error(`--format must be zip, tar, gzip, or tar.gz (got '${format}')`)
    const bytes = new Uint8Array(readFileSync(archivePath))
    if (!opts.output) {
      const { entries, skipped } = archiveExtract(format, bytes)
      console.log(JSON.stringify({
        entries: entries.map((e) => ({ name: e.name, bytes: e.bytes, text: e.text, truncated: e.truncated, mtime: e.mtime, base64: bytesToB64(e.data) })),
        ...(skipped?.length ? { skipped } : {}),
      }, null, 2))
      return
    }
    const { written, skipped } = extractArchiveTo(format, bytes, opts.output)
    console.log(`extracted ${written} entr${written === 1 ? 'y' : 'ies'} to ${opts.output}`)
    if (skipped.length) {
      console.log(`skipped ${skipped.length} non-regular entr${skipped.length === 1 ? 'y' : 'ies'} (symlink/hardlink/device): ${skipped.map((s) => `${s.name} (${s.typeflag})`).join(', ')}`)
    }
  })

function inferArchiveFormat(path: string): ArchiveFormat {
  if (path.endsWith('.zip')) return 'zip'
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return 'tar.gz'
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
    if (e.mtime !== undefined) utimesSync(dest, e.mtime / 1000, e.mtime / 1000)
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

pdfCmd
  .command('page-count')
  .description('Report a PDF\'s page count')
  .argument('<file>', 'input PDF')
  .action(async (file: string) => {
    const input = new Uint8Array(readFileSync(file))
    const count = await pdfPageCount(input)
    console.log(String(count))
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
    if (types) {
      const invalid = types.filter((t) => !REDACT_TYPES.includes(t))
      if (invalid.length) throw new Error(`--types must be a comma-separated subset of: ${REDACT_TYPES.join(', ')} (got invalid: ${invalid.join(', ')})`)
    }
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

// ---------- pipeline ----------

const pipelineCmd = program.command('pipeline').description('Run a JSON op-tree pipeline against the leaf registry')

function isFileRef(v: unknown): v is { $file: string; type?: string } {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).$file === 'string'
}

/**
 * Walks a spec file's `input`, turning every `{ "$file": "<path>", "type"?:
 * "<mime>" }` marker into a Handle ref (`{ $handle: true, base64, type }`) by
 * reading the referenced file off disk — the CLI's equivalent of `POST
 * /op/run`'s caller manually base64-encoding a Handle into the request body.
 * `<path>` resolves relative to the spec file's own directory, not cwd, so a
 * spec file is portable regardless of where it's invoked from.
 */
function resolveFileRefs(value: unknown, baseDir: string): unknown {
  if (isFileRef(value)) {
    const bytes = new Uint8Array(readFileSync(resolve(baseDir, value.$file)))
    return { $handle: true, base64: bytesToB64(bytes), ...(value.type !== undefined ? { type: value.type } : {}) }
  }
  if (Array.isArray(value)) return value.map((v) => resolveFileRefs(v, baseDir))
  if (value && typeof value === 'object') {
    // Object.create(null), not {}: mirrors op-run.ts's hydrate() guard —
    // a spec-file key literally named "__proto__" assigned onto a plain {}
    // accumulator would hit the inherited Annex-B setter instead of becoming
    // an ordinary own property.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = resolveFileRefs(v, baseDir)
    return out
  }
  return value
}

function isDehydratedHandle(v: unknown): v is { base64: string; type: string; size: number } {
  if (typeof v !== 'object' || v === null) return false
  const h = v as Record<string, unknown>
  return typeof h.base64 === 'string' && typeof h.type === 'string' && typeof h.size === 'number'
}

const MIME_EXT: Record<string, string> = {
  'application/zip': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/json': 'json',
  'text/plain': 'txt',
}

function extFromMime(type: string): string {
  return MIME_EXT[type] ?? (type.split('/').pop()?.replace(/[^a-z0-9]/gi, '') || 'bin')
}

/**
 * Reverse of resolveFileRefs for the result side: replaces every
 * dehydrated-Handle-shaped value (`{ base64, type, size }`, runOpSpec's
 * output shape) with a `{ file, type, size }` pointer and collects the bytes
 * to write, instead of inlining potentially large base64 in the printed JSON.
 */
function extractHandleFiles(value: unknown, files: Array<{ name: string; bytes: Uint8Array }>): unknown {
  if (isDehydratedHandle(value)) {
    const name = `handle-${files.length}.${extFromMime(value.type)}`
    files.push({ name, bytes: b64ToBytes(value.base64) })
    return { file: name, type: value.type, size: value.size }
  }
  if (Array.isArray(value)) return value.map((v) => extractHandleFiles(v, files))
  if (value && typeof value === 'object') {
    // Object.create(null), not {}: mirrors resolveFileRefs' guard above — a
    // result key literally named "__proto__" assigned onto a plain {}
    // accumulator would hit the inherited Annex-B setter instead of becoming
    // an ordinary own property.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(value)) out[k] = extractHandleFiles(v, files)
    return out
  }
  return value
}

/**
 * Loads `--config <path>`'s module and returns its default export as an
 * OpRunOpts -- the shell binary's way of reaching a live Llm/Store/Cache/
 * Governors/Sinks object, which (unlike a programmatic caller of `main()`)
 * it has no way to construct from argv alone. tsx (already how
 * bin/fileops.mjs runs this whole CLI) lets a dynamic `import()` load
 * arbitrary TS at runtime, so a `--config` module can be .ts without any
 * extra build step. `pathToFileURL` makes the resolved path import-safe on
 * every platform (a bare absolute path isn't a valid module specifier on
 * Windows).
 */
async function loadOpRunOptsConfig(configPath: string): Promise<OpRunOpts> {
  const resolved = resolve(configPath)
  const mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown }
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(`--config module '${configPath}' must have a default export (an OpRunOpts object)`)
  }
  return mod.default as OpRunOpts
}

// Read by main() to refresh pipelineRunCmd's description right before
// parsing, once opRunOpts.leaves (a programmatic caller's host-registered
// leaves) is known -- unlike mcp.ts's run_pipeline (whose opts are already in
// scope when its description is built), this Command tree is built once at
// module load, before main(argv, opRunOpts) is ever called. `--config`'s
// leaves stay out of reach here regardless: that module only loads inside
// `run`'s own action, per invocation, after --help would already have been
// handled -- there's no point in the CLI lifecycle where it's known before a
// help string needs to exist (#158).
function pipelineRunDescription(leaves: Record<string, unknown>): string {
  return 'Run a JSON op-tree pipeline spec over the leaf registry ' +
    `(${Object.keys(leaves).join(', ')}), mirroring POST /op/run's request body.`
}

// Exported for tests: main() refreshes this command's description right
// before parsing, based on opRunOpts.leaves (#158) -- asserting on the
// rendered description is otherwise only reachable by shelling out to
// `--help` and dealing with commander's process.exit-on-help behavior.
export const pipelineRunCmd = pipelineCmd
  .command('run')
  .description(pipelineRunDescription(mergeLeaves()))
  .argument('<spec-file>', 'JSON file: { spec: OpSpec, input }. Input values shaped { "$file": "<path>", "type"?: "<mime>" } are read off disk and marshalled into Handle refs.')
  .option('-o, --output <dir>', 'write Handle-shaped result value(s) to files in this directory instead of inlining base64 in the printed JSON')
  .option('-c, --config <path>', 'path to a JS/TS module (default export) supplying an OpRunOpts object -- llm/store/cache/governors/sinks for this run, the shell CLI\'s equivalent of a programmatic caller\'s main(argv, opRunOpts)')
  .option('--trace', 'include a TraceEvent[] execution trace alongside the result')
  .option('--run-id <id>', 'resume a previously checkpointed run by passing back its runId (requires --config to supply a checkpoint capability)')
  .action(async (specFile: string, opts: { output?: string; config?: string; trace?: boolean; runId?: string }) => {
    const parsed = JSON.parse(readFileSync(specFile, 'utf8')) as { spec?: unknown; input?: unknown }
    if (!parsed.spec || typeof parsed.spec !== 'object') throw new Error('spec file must contain a `spec` (an op-tree JSON description)')
    const input = resolveFileRefs(parsed.input, dirname(resolve(specFile)))
    const runOpts = opts.config ? { ...cliOpRunOpts, ...(await loadOpRunOptsConfig(opts.config)) } : cliOpRunOpts
    const outcome = await runOpSpec({ spec: parsed.spec as OpSpec, input, trace: !!opts.trace, runId: opts.runId }, runOpts)
    // runOpSpec wraps its return in { result, runId } (or { result, trace, runId })
    // whenever runOpts.checkpoint is configured -- independent of --trace, see
    // op-run.ts's runOpSpec doc -- so unwrapping only on opts.trace (pre-#408)
    // mistook the whole wrapper for the result whenever a --config module supplied
    // a checkpoint with no --trace. Mirrors http.ts's POST /op/run unwrap condition.
    const wrapped = !!opts.trace || !!runOpts.checkpoint
    const result = wrapped ? (outcome as { result: unknown }).result : outcome
    if (runOpts.checkpoint) console.error(`runId: ${(outcome as { runId: string }).runId}`)
    if (opts.output) {
      const files: Array<{ name: string; bytes: Uint8Array }> = []
      const shaped = extractHandleFiles(result, files)
      mkdirSync(opts.output, { recursive: true })
      for (const f of files) writeFileSync(join(opts.output, f.name), f.bytes)
      const printed = opts.trace ? { result: shaped, trace: (outcome as { trace: unknown }).trace } : shaped
      console.log(JSON.stringify(printed, null, 2))
      if (files.length) console.log(`wrote ${files.length} handle result(s) to ${opts.output}`)
    } else {
      console.log(JSON.stringify(opts.trace ? { result, trace: (outcome as { trace: unknown }).trace } : result))
    }
  })

/** Prints the same leaf/sink/reconcile-mode/field-policy schema `describe_pipeline`
 * (mcp.ts) and `GET /op/schema` (http.ts) expose, so a caller building a
 * `pipeline run` spec file can discover the current op-tree grammar without
 * digging through source (#187). `--config` mirrors `pipeline run`'s own flag,
 * so host-registered leaves/sinks show up here too, not just the built-ins. */
pipelineCmd
  .command('describe')
  .description('Print the op-tree pipeline schema (leaves, sinks, reconcile modes, field-merge policies) as JSON')
  .option('-c, --config <path>', 'path to a JS/TS module (default export) supplying an OpRunOpts object -- same as `pipeline run --config`, for host-registered leaves/sinks')
  .action(async (opts: { config?: string }) => {
    const runOpts = opts.config ? { ...cliOpRunOpts, ...(await loadOpRunOptsConfig(opts.config)) } : cliOpRunOpts
    console.log(JSON.stringify(describePipelineSchema(runOpts.leaves, runOpts.sinks)))
  })

/** Checks a spec file's `spec` against the same structural rules `pipeline run`
 * would enforce via buildOp, but collects every error into one report instead
 * of throwing on the first (#208) -- mirrors `pipeline describe`'s `--config`
 * handling so host-registered leaves validate correctly too. Exits non-zero
 * when the spec is invalid, so this is scriptable as a pre-flight lint step. */
pipelineCmd
  .command('validate')
  .description('Check a JSON op-tree spec for structural errors without running it; prints every error found, not just the first')
  .argument('<spec-file>', 'JSON file: { spec: OpSpec }')
  .option('-c, --config <path>', 'path to a JS/TS module (default export) supplying an OpRunOpts object -- same as `pipeline run --config`, for host-registered leaves')
  .action(async (specFile: string, opts: { config?: string }) => {
    const parsed = JSON.parse(readFileSync(specFile, 'utf8')) as { spec?: unknown }
    if (!parsed.spec || typeof parsed.spec !== 'object') throw new Error('spec file must contain a `spec` (an op-tree JSON description)')
    const runOpts = opts.config ? { ...cliOpRunOpts, ...(await loadOpRunOptsConfig(opts.config)) } : cliOpRunOpts
    const errors = validateOpSpec(parsed.spec as OpSpec, runOpts.leaves)
    console.log(JSON.stringify({ valid: errors.length === 0, errors }, null, 2))
    if (errors.length) process.exitCode = 1
  })

/** Non-executing cost/capability audit (#361) -- reports node count, worst-case
 * map/mapField concurrency, worst-case Σ(retries+1) retry multiplier, and which
 * optional Caps fields (ask/cache/llm/sink targets) the spec will reach if run,
 * without touching caps.store/llm/sinks or building the actual Op tree. See
 * src/op/plan.ts's planOpSpec doc for the full breakdown. */
pipelineCmd
  .command('plan')
  .description('Report a non-executing cost/capability audit for a JSON op-tree spec (node count, worst-case concurrency/retries, Caps reachability)')
  .argument('<spec-file>', 'JSON file: { spec: OpSpec }')
  .action(async (specFile: string) => {
    const parsed = JSON.parse(readFileSync(specFile, 'utf8')) as { spec?: unknown }
    if (!parsed.spec || typeof parsed.spec !== 'object') throw new Error('spec file must contain a `spec` (an op-tree JSON description)')
    console.log(JSON.stringify(planOpSpec(parsed.spec as OpSpec), null, 2))
  })

/** Re-exported for tests: the actual dispatch logic is `dispatchTransform` in
 * src/domain/transform.ts, shared verbatim by the CLI, HTTP, and MCP adapters —
 * this alias just keeps tests importing `transform` from here working. */
export const transform = dispatchTransform

/** Entry point called by bin/fileops.mjs. Kept separate from module load so
 * importing `transform` (e.g. from tests) never triggers argv parsing.
 * `opRunOpts` lets a programmatic caller (not the bin script, which has no
 * way to construct a live JS object from argv) supply `pipeline run` the
 * same host-configurable governors/cache/store/sinks/llm HTTP's Env and
 * MCP's RegisterFileopsToolsOptions already offer runOpSpec. `allowCommands`
 * restricts the exposed top-level command tree (e.g. `['transform',
 * 'sanitize']`) to that subset, mirroring MCP's `RegisterFileopsToolsOptions
 * .allow` / HTTP's `Env.allowRoutes` -- every command is available when
 * omitted. Re-applied fresh on every call against the full command list
 * captured at module load, so one call's subset never leaks into the next
 * call's default. */
export async function main(argv: string[] = process.argv, opRunOpts: OpRunOpts = {}, allowCommands?: string[]): Promise<void> {
  cliOpRunOpts = opRunOpts
  pipelineRunCmd.description(pipelineRunDescription(mergeLeaves(opRunOpts.leaves)))
  // argv[2] is the top-level subcommand name (archive/pdf/sanitize/transform/pipeline)
  // for every invocation shape this CLI supports -- checked ahead of commander's own
  // parsing rather than by mutating `program.commands` (a readonly-typed array on the
  // module-level singleton Command; reassigning/splicing it would also need resetting
  // back to the full set on every call to avoid one call's subset leaking into the next).
  if (allowCommands && argv[2] !== undefined && !allowCommands.includes(argv[2]) && argv[2] !== '--help' && argv[2] !== '-h') {
    console.error(`error: unknown command '${argv[2]}' (allowed: ${allowCommands.join(', ')})`)
    process.exitCode = 1
    return
  }
  try {
    await program.parseAsync(argv)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exitCode = 1
  }
}
