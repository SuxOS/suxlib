import type { Op, Caps } from '../op/types.js'
import { runReconcile } from '../op/reconcile.js'
import { runGoverned, type RunGovernedOpts } from '../control/governor.js'

export class AskTimeoutError extends Error {
  constructor(readonly prompt: string) {
    super(`ask timed out with no answer: "${prompt}"`)
    this.name = 'AskTimeoutError'
  }
}

export async function runInline(node: Op, input: any, caps: Caps, gOpts?: RunGovernedOpts): Promise<any> {
  switch (node.tag) {
    case 'leaf': return runGoverned(node.name, node.opts, node.fn, input, caps, caps.governors?.[node.name], gOpts)
    case 'pipe': { let v = input; for (const s of node.steps) v = await runInline(s, v, caps, gOpts); return v }
    case 'map': {
      const items: any[] = input; const out = new Array(items.length)
      await Promise.all(items.map(async (it, i) => {
        await node.concurrency.acquire()
        try { out[i] = await runInline(node.op, it, caps, gOpts); node.concurrency.release(true) }
        catch (e) { node.concurrency.release(false); throw e }
      }))
      return out
    }
    case 'mapField': {
      const obj = input as Record<string, unknown>
      const items = obj[node.arrayField] as any[]
      const out = new Array(items.length)
      await Promise.all(items.map(async (it, i) => {
        await node.concurrency.acquire()
        try {
          const value = await runInline(node.op, (it as Record<string, unknown>)[node.elementField], caps, gOpts)
          out[i] = { ...(it as Record<string, unknown>), [node.elementField]: value }
          node.concurrency.release(true)
        } catch (e) { node.concurrency.release(false); throw e }
      }))
      const { [node.arrayField]: _dropped, ...rest } = obj
      return { ...rest, [node.renameTo ?? node.arrayField]: out }
    }
    case 'reconcile': return runReconcile(node.opts, input, caps.store)
    case 'sink': {
      await Promise.all(node.targets.map(t => {
        const s = caps.sinks[t]
        if (!s) throw new Error(`unknown sink "${t}" (registered: ${Object.keys(caps.sinks).join(', ')})`)
        return s.write(input, caps)
      }))
      return input
    }
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
