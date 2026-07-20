import { test, expect } from 'vitest'
import { PDFDocument, PDFName } from 'pdf-lib'
import { pdfShrink, pdfPageCount, loadBoundedPdf, shrink, pageCount, MAX_PDF_INPUT_BYTES } from '../../src/domain/pdf.js'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolve } from '../../src/handles/handle.js'

async function blankPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([300, 400])
  doc.setTitle('My Title')
  doc.setAuthor('Ada')
  return doc.save()
}

// Builds a fixture with a catalog XMP /Metadata stream -- pdf-lib's
// setTitle/etc. only ever touch the classic /Info dict, so the only way to
// get an XMP packet into a test fixture is via the low-level context API
// (mirrors how a real Acrobat/Office/LibreOffice export embeds one).
async function pdfWithXmp(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([300, 400])
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Confidential Report</dc:title></rdf:Description>' +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })
  const ref = doc.context.register(stream)
  doc.catalog.set(PDFName.of('Metadata'), ref)
  return doc.save()
}

test('pdfShrink strips metadata by default and reports byte savings', async () => {
  const input = await blankPdf(1)
  const result = await pdfShrink(input)
  expect(result.inputBytes).toBe(input.length)
  expect(result.outputBytes).toBe(result.bytes.length)
  const out = await PDFDocument.load(result.bytes)
  expect(out.getTitle() ?? '').toBe('')
  expect(out.getAuthor() ?? '').toBe('')
})

test('pdfShrink clears a catalog XMP /Metadata stream, not just the Info dict', async () => {
  const input = await pdfWithXmp()
  expect(new TextDecoder('latin1').decode(input)).toContain('Confidential Report')
  const result = await pdfShrink(input, { stripMetadata: true })
  const outText = new TextDecoder('latin1').decode(result.bytes)
  expect(outText).not.toContain('Confidential Report')
  const out = await PDFDocument.load(result.bytes)
  expect(out.catalog.get(PDFName.of('Metadata'))).toBeUndefined()
})

test('pdfShrink keeps metadata when stripMetadata is false', async () => {
  const input = await blankPdf(1)
  const result = await pdfShrink(input, { stripMetadata: false })
  const out = await PDFDocument.load(result.bytes)
  expect(out.getTitle()).toBe('My Title')
})

test('shrink (Handle-based leaf) round-trips a PDF through a Store and reports the same stats as pdfShrink', async () => {
  const store = new MemoryStore()
  const input = await blankPdf(1)
  const handle = await putBytes(store, input, 'application/pdf')
  const result = await shrink({ handle }, { store } as any)
  expect(result.inputBytes).toBe(input.length)
  const outBytes = await resolve(store, result.handle)
  expect(result.outputBytes).toBe(outBytes.length)
  const out = await PDFDocument.load(outBytes)
  expect(out.getTitle() ?? '').toBe('')
})

test('pdfPageCount reports the page count', async () => {
  const input = await blankPdf(3)
  expect(await pdfPageCount(input)).toBe(3)
})

test('pageCount (Handle-based leaf) resolves the input Handle and reports the same count as pdfPageCount', async () => {
  const store = new MemoryStore()
  const input = await blankPdf(3)
  const handle = await putBytes(store, input, 'application/pdf')
  expect(await pageCount(handle, { store } as any)).toBe(3)
})

test('loadBoundedPdf rejects a PDF larger than MAX_PDF_INPUT_BYTES', async () => {
  const big = new Uint8Array(MAX_PDF_INPUT_BYTES + 1)
  await expect(loadBoundedPdf(big)).rejects.toThrow(/bomb guard/)
})

test('loadBoundedPdf rejects a tiny file whose declared object-stream count is pathological, before ever calling PDFDocument.load', async () => {
  const bytes = new TextEncoder().encode(
    '%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N 600000 /First 10 /Length 1 >>\nstream\nx\nendstream\nendobj\n%%EOF',
  )
  await expect(loadBoundedPdf(bytes)).rejects.toThrow(/bomb guard/)
})
