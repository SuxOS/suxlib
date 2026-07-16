// PDF shrink/compress. Pure — no fetch, no filesystem. Ported from
// sux-fileops's src/core/pdf.ts during the suxlib absorption of sux-fileops.
// This is deliberately narrow scope (shrink, not the full "anything to PDF"
// builder that stays in sux's src/fns/pdf.ts — that builder merges/renders
// many source kinds and is out of the fileops-absorption boundary; it reuses
// loadBoundedPdf below for its own bomb-guarded PDFDocument.load() call).

import { PDFDocument } from 'pdf-lib'

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
 * retained graph, not load()'s transient peak (a full fix needs a
 * resource-limited parse context and is out of scope here).
 */
export const MAX_PDF_OBJECTS = 500_000

/**
 * Load a PDF with the two size guards every entry point shares: a pre-parse
 * byte cap and a post-parse object-count cap. Both throw a "(bomb guard)."
 * Error matching the archive.ts idiom so adapters surface a uniform message.
 */
export async function loadBoundedPdf(input: Uint8Array): Promise<PDFDocument> {
  if (input.length > MAX_PDF_INPUT_BYTES) {
    throw new Error(`PDF is larger than ${MAX_PDF_INPUT_BYTES} bytes (bomb guard).`)
  }
  const doc = await PDFDocument.load(input, { updateMetadata: false })
  const objectCount = doc.context.enumerateIndirectObjects().length
  if (objectCount > MAX_PDF_OBJECTS) {
    throw new Error(`PDF expands to more than ${MAX_PDF_OBJECTS} objects (bomb guard).`)
  }
  return doc
}

export type PdfShrinkOptions = {
  /** Clear Title/Author/Subject/Keywords/Producer metadata. Default true. */
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
