import type { Op, Caps } from '../op/types.js'
import { runReconcile } from '../op/reconcile.js'
import { runGoverned } from '../control/governor.js'

export class AskTimeoutError extends Error {
  constructor(readonly prompt: string) {
    super(`ask timed out with no answer: "${prompt}"`)
    this.name = 'AskTimeoutError'
  }
}

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
    case 'ask': {
      // No Ask capability: there is no way to pause for a human answer, so an
      // immediate "timeout" is the honest default -- honor onTimeout rather than
      // silently overriding a caller's explicit 'fail' contract with 'proceed'.
      if (!caps.ask) {
        if (node.onTimeout === 'fail') throw new AskTimeoutError(node.prompt)
        return input
      }
      const result = await caps.ask.request(node.prompt, node.timeout)
      if (result.answered) return result.value !== undefined ? result.value : input
      if (node.onTimeout === 'fail') throw new AskTimeoutError(node.prompt)
      return input
    }
  }
}
