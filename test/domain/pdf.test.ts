import { test, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { pdfShrink, pdfPageCount, loadBoundedPdf, shrink, MAX_PDF_INPUT_BYTES } from '../../src/domain/pdf.js'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, resolve } from '../../src/handles/handle.js'

async function blankPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([300, 400])
  doc.setTitle('My Title')
  doc.setAuthor('Ada')
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
