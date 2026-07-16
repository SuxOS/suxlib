import type { Op, LeafFn, LeafOpts } from './types.js'
export const op = (name: string, fn: LeafFn, opts: LeafOpts): Op => ({ tag: 'leaf', name, fn, opts })
export const pipe = (...steps: Op[]): Op => ({ tag: 'pipe', steps })
