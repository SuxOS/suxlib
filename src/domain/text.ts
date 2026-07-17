import type { LeafFn } from '../op/types.js'
import { resolve, putText, resolveText } from '../handles/handle.js'
export const extract: LeafFn = async (pdfHandle, caps) => {
  const md = await caps.llm.markdownFromPdf(await resolve(caps.store, pdfHandle))
  return putText(caps.store, md, 'text/markdown')
}
export const summarize: LeafFn = async (masterHandle, caps) => {
  const abstract = await caps.llm.summarize(await resolveText(caps.store, masterHandle))
  return { abstract, summaryHandle: await putText(caps.store, abstract, 'text/markdown') }
}
