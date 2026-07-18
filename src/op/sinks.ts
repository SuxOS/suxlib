import type { SinkTarget } from './types.js'
import { putText } from '../handles/handle.js'

/**
 * name -> SinkTarget registry for the sink node's built-in targets, the same
 * role LEAF_REGISTRY (./registry.ts) plays for leaf names -- an adapter (CLI/
 * HTTP/MCP) has no way to hand a `sink`/`sink.fanout` spec a live SinkTarget
 * object, only a name, so this is what a JSON op spec (./spec.ts) resolves a
 * target name against at run time via Caps.sinks.
 *
 * `store` is the only built-in: it re-puts the piped value into caps.store as
 * JSON, which works for any adapter-triggered run since every Caps already
 * carries a Store (op/types.ts) -- no host wiring required. A host that wants
 * a real external sink (a log, a queue, a second store) supplies it via
 * OpRunOpts.sinks (src/adapters/op-run.ts), merged alongside this registry.
 */
export const STORE_SINK: SinkTarget = {
  name: 'store',
  async write(input, caps) {
    return putText(caps.store, JSON.stringify(input), 'application/json')
  },
}

// Object.create(null), not {}: mirrors LEAF_REGISTRY's guard (./registry.ts)
// against a target name like 'constructor'/'toString' resolving to an
// inherited Object.prototype member instead of throwing "unknown sink".
export const SINK_REGISTRY: Readonly<Record<string, SinkTarget>> = Object.freeze(
  Object.assign(Object.create(null), { store: STORE_SINK }),
)
