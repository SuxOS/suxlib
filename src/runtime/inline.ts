import type { Op, Caps } from '../op/types.js'
import { faithfulUnion } from '../op/reconcile.js'
export async function runInline(node: Op, input: any, caps: Caps): Promise<any> {
  switch (node.tag) {
    case 'leaf': return node.fn(input, caps)
    case 'pipe': { let v = input; for (const s of node.steps) v = await runInline(s, v, caps); return v }
    case 'map': {
      const items: any[] = input; const out = new Array(items.length)
      await Promise.all(items.map(async (it, i) => {
        await node.concurrency.acquire()
        try { out[i] = await runInline(node.op, it, caps); node.concurrency.release(true) }
        catch (e) { node.concurrency.release(false); throw e }
      }))
      return out
    }
    case 'reconcile':
      if (node.opts.mode !== 'faithful-union') throw new Error(`reconcile mode not yet wired: ${node.opts.mode}`)
      return faithfulUnion(input, caps.store)
    case 'sink': { await Promise.all(node.targets.map(t => caps.sinks[t].write(input, caps))); return input }
    case 'ask': return input // inline mode: no human pause; proceed with the piped value
  }
}
