import { test, expect } from 'vitest'
import { extract, summarize } from '../../src/domain/text.js'
import { MemoryStore } from '../../src/effects/types.js'
import type { Llm } from '../../src/effects/types.js'
import type { Caps } from '../../src/op/types.js'

function fakeCaps(llm: Llm): Caps {
  return { store: new MemoryStore(), llm, clock: { now: () => 0 }, sinks: {} }
}

test('extract resolves the pdf handle, calls markdownFromPdf, and stores the result as text/markdown', async () => {
  const llm: Llm = {
    markdownFromPdf: async (bytes) => `# md for ${new TextDecoder().decode(bytes)}`,
    summarize: async () => { throw new Error('unused') },
  }
  const caps = fakeCaps(llm)
  const pdfHandle = await caps.store.put(new TextEncoder().encode('pdf-bytes'), 'application/pdf')
  const out = await extract(pdfHandle, caps)
  expect(out.type).toBe('text/markdown')
  expect(new TextDecoder().decode(await caps.store.get(out))).toBe('# md for pdf-bytes')
})

test('summarize resolves text, calls summarize, and returns abstract + summaryHandle', async () => {
  const llm: Llm = {
    markdownFromPdf: async () => { throw new Error('unused') },
    summarize: async (text) => `summary of ${text}`,
  }
  const caps = fakeCaps(llm)
  const masterHandle = await caps.store.put(new TextEncoder().encode('the full text'), 'text/markdown')
  const { abstract, summaryHandle } = await summarize(masterHandle, caps)
  expect(abstract).toBe('summary of the full text')
  expect(summaryHandle.type).toBe('text/markdown')
  expect(new TextDecoder().decode(await caps.store.get(summaryHandle))).toBe('summary of the full text')
})
