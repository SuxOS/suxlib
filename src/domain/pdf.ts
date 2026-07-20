// PDF shrink/compress. Pure — no fetch, no filesystem. Ported from
// sux-fileops's src/core/pdf.ts during the suxlib absorption of sux-fileops.
// This is deliberately narrow scope (shrink, not the full "anything to PDF"
// builder that stays in sux's src/fns/pdf.ts — that builder merges/renders
// many source kinds and is out of the fileops-absorption boundary; it reuses
// loadBoundedPdf below for its own bomb-guarded PDFDocument.load() call).

import { PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import type { LeafFn } from '../op/types.js'
import type { Handle } from '../effects/types.js'
import { resolve, putBytes } from '../handles/handle.js'

/**
 * Reject a PDF larger than this before handing it to pdf-lib. Bounds the raw
 * on-the-wire byte count — the first, cheapest OOM guard. Note this caps
 * input bytes only, not pdf-lib's peak parse-time allocation.
 */
export const MAX_PDF_INPUT_BYTES = 50_000_000

/**
 * Reject a parsed PDF whose object graph exceeds this many indirect objects.
 * A small crafted PDF (under MAX_PDF_INPUT_BYTES) with pathological object-stream
 * repetition can expand into a huge object graph during load; this post-parse
 * check bounds that expansion. It runs *after* PDFDocument.load, so it caps the
 * retained graph, not load()'s transient peak. estimateDeclaredPdfObjectCount
 * below is a cheap pre-parse partial mitigation for that peak; a full fix needs
 * a resource-limited parse context and is out of scope here.
 */
export const MAX_PDF_OBJECTS = 500_000

/**
 * Chunked byte->latin1-string decode (mirrors adapters/base64.ts's chunked
 * String.fromCharCode use) — avoids both a call-stack blowup from spreading a
 * huge array and relying on TextDecoder encodings beyond 'utf-8', which isn't
 * universally available across this repo's target runtimes.
 */
function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return s
}

/**
 * Estimate the declared object count straight from the raw bytes, without
 * invoking pdf-lib's parser — mirrors archive.ts's unzipSync validation-only
 * pre-pass: reject the obviously pathological case cheaply, before paying for
 * the expensive parse. Counts indirect-object headers (`N N obj`) plus, for
 * each object-stream dictionary (`/Type /ObjStm`), its declared `/N` — the
 * count of further objects that single stream unpacks into. That second term
 * is what catches the attack this guard exists for: object-stream repetition
 * can declare a huge /N while the stream's own compressed bytes stay tiny, so
 * a plain obj-header count alone would miss it. This is a heuristic over raw
 * bytes, not a real parse — it estimates load()'s peak, it doesn't bound it.
 */
function estimateDeclaredPdfObjectCount(input: Uint8Array): number {
  const text = bytesToLatin1(input)
  const objHeaders = (text.match(/\d+\s+\d+\s+obj\b/g) ?? []).length
  let objStreamObjects = 0
  let searchFrom = 0
  for (;;) {
    const idx = text.indexOf('/ObjStm', searchFrom)
    if (idx === -1) break
    const window = text.slice(idx, idx + 200)
    const n = Number(window.match(/\/N\s+(\d+)/)?.[1])
    if (Number.isFinite(n)) objStreamObjects += n
    searchFrom = idx + '/ObjStm'.length
  }
  return objHeaders + objStreamObjects
}

/**
 * Load a PDF with the size guards every entry point shares: a pre-parse byte
 * cap, a pre-parse declared-object-count estimate, and a post-parse
 * object-count cap. All three throw a "(bomb guard)." error matching the
 * archive.ts idiom so adapters surface a uniform message.
 */
export async function loadBoundedPdf(input: Uint8Array): Promise<PDFDocument> {
  if (input.length > MAX_PDF_INPUT_BYTES) {
    throw new Error(`PDF is larger than ${MAX_PDF_INPUT_BYTES} bytes (bomb guard).`)
  }
  if (estimateDeclaredPdfObjectCount(input) > MAX_PDF_OBJECTS) {
    throw new Error(`PDF declares more than ${MAX_PDF_OBJECTS} objects (bomb guard).`)
  }
  const doc = await PDFDocument.load(input, { updateMetadata: false })
  const objectCount = doc.context.enumerateIndirectObjects().length
  if (objectCount > MAX_PDF_OBJECTS) {
    throw new Error(`PDF expands to more than ${MAX_PDF_OBJECTS} objects (bomb guard).`)
  }
  return doc
}

export type PdfShrinkOptions = {
  /** Clear Title/Author/Subject/Keywords/Producer metadata (both the classic
   *  /Info dict and, if present, the catalog's XMP /Metadata stream — a
   *  second, separate metadata carrier that Acrobat/Office/etc. commonly
   *  populate and frequently duplicates Title/Author into). Default true. */
  stripMetadata?: boolean
}

export type PdfShrinkResult = {
  bytes: Uint8Array
  inputBytes: number
  outputBytes: number
  savedPct: number
}

/**
 * Shrink a PDF: re-save with cross-reference object streams (a more compact
 * encoding pdf-lib doesn't use by default) and, by default, strip
 * document-info metadata. This does not recompress embedded images (no image
 * codec dependency here — that's a heavier op left for a follow-up); it's the
 * "working first" structural win: smaller xref tables and no metadata bloat.
 */
export async function pdfShrink(input: Uint8Array, opts: PdfShrinkOptions = {}): Promise<PdfShrinkResult> {
  const stripMetadata = opts.stripMetadata ?? true
  const doc = await loadBoundedPdf(input)

  if (stripMetadata) {
    doc.setTitle('')
    doc.setAuthor('')
    doc.setSubject('')
    doc.setKeywords([])
    doc.setProducer('@suxos/lib')
    doc.setCreator('')

    // setTitle/etc. above only clear the classic /Info dict -- a document's
    // catalog can separately reference an XMP /Metadata stream (loadBoundedPdf
    // passes { updateMetadata: false }, so pdf-lib never syncs the two) that
    // still carries the original dc:title/dc:creator verbatim. Deleting the
    // catalog's /Metadata key alone isn't enough either: PDFWriter.serializeToBuffer
    // serializes every object in context.enumerateIndirectObjects() regardless
    // of reachability from the trailer, so an unreferenced stream's bytes
    // would still round-trip into the output. Drop the underlying indirect
    // object from the context too so the XMP bytes never get written at all.
    const metadataKey = PDFName.of('Metadata')
    const metadataRef = doc.catalog.get(metadataKey)
    if (metadataRef !== undefined) {
      doc.catalog.delete(metadataKey)
      if (metadataRef instanceof PDFRef) doc.context.delete(metadataRef)
    }
  }

  const bytes = await doc.save({ useObjectStreams: true })
  const inputBytes = input.length
  const outputBytes = bytes.length
  const savedPct = inputBytes ? Number((((inputBytes - outputBytes) / inputBytes) * 100).toFixed(1)) : 0
  return { bytes, inputBytes, outputBytes, savedPct }
}

/** Page count of a PDF — small helper used by the CLI/HTTP/MCP adapters for reporting. */
export async function pdfPageCount(input: Uint8Array): Promise<number> {
  const doc = await loadBoundedPdf(input)
  return doc.getPageCount()
}

// shrink: Handle-based wrapper around pdfShrink, following archive.ts's
// pack/unpack — resolve the input Handle, run the pure function, put the
// result back as a Handle.
export type ShrinkInput = { handle: Handle } & PdfShrinkOptions
export const shrink: LeafFn = async (input, caps) => {
  const { handle, ...opts } = input as ShrinkInput
  const bytes = await resolve(caps.store, handle)
  const result = await pdfShrink(bytes, opts)
  return { handle: await putBytes(caps.store, result.bytes, 'application/pdf'), inputBytes: result.inputBytes, outputBytes: result.outputBytes, savedPct: result.savedPct }
}

// pageCount: Handle-based wrapper around pdfPageCount, following unzip/scrub's
// bare-Handle-in pattern — resolves the input Handle and returns a bare
// number, no Handle to put back.
export const pageCount: LeafFn = async (input, caps) => {
  const bytes = await resolve(caps.store, input as Handle)
  return pdfPageCount(bytes)
}
