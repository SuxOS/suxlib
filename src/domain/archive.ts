import { unzipSync } from 'fflate'
import type { LeafFn } from '../op/types.js'
import { resolve, putBytes } from '../handles/handle.js'
export const unzip: LeafFn = async (zipHandle, caps) => {
  const bytes = await resolve(caps.store, zipHandle)
  const files = unzipSync(bytes)
  return Promise.all(Object.entries(files).map(([name, data]) =>
    putBytes(caps.store, data, name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream')))
}
