import type { Op, Caps } from '../op/types.js'
import { runReconcile } from '../op/reconcile.js'
import { runGoverned } from '../control/governor.js'
export async function runInline(node: Op, input: any, caps: Caps): Promise<any> {
  switch (node.tag) {
    case 'leaf': return runGoverned(node.name, node.opts, node.fn, input, caps, caps.governors?.[node.name])
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
    case 'reconcile': return runReconcile(node.opts, input, caps.store)
    case 'sink': { await Promise.all(node.targets.map(t => caps.sinks[t].write(input, caps))); return input }
    case 'ask': return input // inline mode: no human pause; proceed with the piped value
  }
}
