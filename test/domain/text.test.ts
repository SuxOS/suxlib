import { test, expect } from 'vitest'
import { MemoryStore } from '../../src/effects/types.js'
import { putBytes, putText, resolveText } from '../../src/handles/handle.js'
import { extract, summarize } from '../../src/domain/text.js'

test('extract puts the LLM-returned markdown as text/markdown', async () => {
  const store = new MemoryStore()
  const pdfHandle = await putBytes(store, new Uint8Array([1, 2, 3]), 'application/pdf')
  const llm = {
    markdownFromPdf: async (bytes: Uint8Array) => `# doc (${bytes.byteLength} bytes)`,
    summarize: async () => { throw new Error('unused') },
  }
  const mdHandle = await extract(pdfHandle, { store, llm } as any)
  expect(mdHandle.type).toBe('text/markdown')
  expect(await resolveText(store, mdHandle)).toBe('# doc (3 bytes)')
})

test('summarize returns an abstract and a handle resolving to the stubbed text', async () => {
  const store = new MemoryStore()
  const masterHandle = await putText(store, 'the full document text')
  const llm = {
    markdownFromPdf: async () => { throw new Error('unused') },
    summarize: async (text: string) => `summary of: ${text}`,
  }
  const { abstract, summaryHandle } = await summarize(masterHandle, { store, llm } as any)
  expect(abstract).toBe('summary of: the full document text')
  expect(summaryHandle.type).toBe('text/markdown')
  expect(await resolveText(store, summaryHandle)).toBe(abstract)
})
