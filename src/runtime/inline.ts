import type { Op, Caps } from '../op/types.js'
import { runReconcile } from '../op/reconcile.js'
import { runGoverned, type RunGovernedOpts } from '../control/governor.js'

export class AskTimeoutError extends Error {
  constructor(readonly prompt: string) {
    super(`ask timed out with no answer: "${prompt}"`)
    this.name = 'AskTimeoutError'
  }
}

const childPath = (path: string, seg: string | number): string => (path === '' ? String(seg) : `${path}/${seg}`)

// Wraps one Op node's execution with node-enter/node-exit trace events (see
// src/control/trace.ts) when gOpts.onTrace is supplied; a bare passthrough
// otherwise -- no timing call, no event object, no try/catch -- so tracing
// costs nothing when a caller doesn't ask for it.
async function traced<T>(tag: string, name: string | undefined, path: string, caps: Caps, gOpts: RunGovernedOpts | undefined, fn: () => Promise<T>): Promise<T> {
  const onTrace = gOpts?.onTrace
  if (!onTrace) return fn()
  const t0 = caps.clock.now()
  onTrace({ kind: 'node-enter', tag, name, path })
  try {
    const result = await fn()
    onTrace({ kind: 'node-exit', tag, name, path, durationMs: caps.clock.now() - t0, ok: true })
    return result
  } catch (err) {
    onTrace({ kind: 'node-exit', tag, name, path, durationMs: caps.clock.now() - t0, ok: false, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

export async function runInline(node: Op, input: any, caps: Caps, gOpts?: RunGovernedOpts, path = ''): Promise<any> {
  switch (node.tag) {
    case 'leaf':
      return traced('leaf', node.name, path, caps, gOpts, () =>
        runGoverned(node.name, node.opts, node.fn, input, caps, caps.governors?.[node.name], gOpts))
    case 'pipe':
      return traced('pipe', undefined, path, caps, gOpts, async () => {
        let v = input
        for (let i = 0; i < node.steps.length; i++) v = await runInline(node.steps[i], v, caps, gOpts, childPath(path, i))
        return v
      })
    case 'map':
      return traced('map', undefined, path, caps, gOpts, async () => {
        const items: any[] = input; const out = new Array(items.length)
        await Promise.all(items.map(async (it, i) => {
          await node.concurrency.acquire()
          try { out[i] = await runInline(node.op, it, caps, gOpts, childPath(path, i)); node.concurrency.release(true) }
          catch (e) { node.concurrency.release(false); throw e }
        }))
        return out
      })
    case 'mapField':
      return traced('mapField', undefined, path, caps, gOpts, async () => {
        const obj = input as Record<string, unknown>
        const items = obj[node.arrayField] as any[]
        const out = new Array(items.length)
        await Promise.all(items.map(async (it, i) => {
          await node.concurrency.acquire()
          try {
            const value = await runInline(node.op, (it as Record<string, unknown>)[node.elementField], caps, gOpts, childPath(path, i))
            out[i] = { ...(it as Record<string, unknown>), [node.elementField]: value }
            node.concurrency.release(true)
          } catch (e) { node.concurrency.release(false); throw e }
        }))
        const { [node.arrayField]: _dropped, ...rest } = obj
        return { ...rest, [node.renameTo ?? node.arrayField]: out }
      })
    case 'reconcile':
      return traced('reconcile', undefined, path, caps, gOpts, () => runReconcile(node.opts, input, caps.store))
    case 'sink':
      // Traced per-target, not just once for the whole fanout: Promise.all
      // gives every target's write equal opportunity to fail independently,
      // and node-exit is the only way to see which target(s) actually failed.
      // Each write runs through runGoverned exactly like an 'effect' leaf's
      // fn -- retries/breaker/tokenBucket/concurrency -- keyed `sink:<target>`
      // in caps.governors so a sink target's gating can't collide with a
      // same-named leaf's own governor entry.
      return traced('sink', undefined, path, caps, gOpts, async () => {
        await Promise.all(node.targets.map(t => traced('sink-target', t, childPath(path, t), caps, gOpts, async () => {
          const s = caps.sinks[t]
          if (!s) throw new Error(`unknown sink "${t}" (registered: ${Object.keys(caps.sinks).join(', ')})`)
          const governorName = `sink:${t}`
          const opts = { kind: 'effect' as const, retries: node.opts?.retries, heavy: node.opts?.heavy, memo: node.opts?.memo }
          return runGoverned(governorName, opts, (v, c) => s.write(v, c), input, caps, caps.governors?.[governorName], gOpts)
        })))
        return input
      })
    case 'ask':
      return traced('ask', undefined, path, caps, gOpts, async () => {
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
      })
    case 'catch':
      // The try branch's own node-exit (path `${path}/try`) carries ok:false
      // and the discarded error's message -- that's what answers "why did the
      // fallback fire" when a caller supplies onTrace; this case itself still
      // only needs the error to decide whether to run the fallback.
      return traced('catch', undefined, path, caps, gOpts, async () => {
        try { return await runInline(node.try, input, caps, gOpts, childPath(path, 'try')) }
        catch { return runInline(node.catch, input, caps, gOpts, childPath(path, 'catch')) }
      })
  }
}
