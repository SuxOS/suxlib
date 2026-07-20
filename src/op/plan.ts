import type { OpSpec } from './spec.js'
import { LEAF_CAPS } from './registry.js'

export type OpPlan = {
  nodeCount: number
  maxConcurrency: number
  maxRetryMultiplier: number
  usesAsk: boolean
  usesCache: boolean
  usesLlm: boolean
  llmLeaves: string[]
  sinkTargets: string[]
}

/**
 * Non-executing cost/capability audit for an OpSpec -- a third structural
 * sibling to describePipelineSchema/validateOpSpec (#361): walks the same
 * tree shape collectSpecErrors (./spec.ts) does, but instead of collecting
 * structural errors it accumulates build-time-known figures a caller (e.g.
 * an MCP client deciding whether to actually run a spec) can use to estimate
 * blast radius before wiring a real run:
 *
 * - `nodeCount`: total OpSpec nodes visited.
 * - `maxConcurrency`: the widest single `map`/`mapField` `concurrency`
 *   declared anywhere in the tree (bounded by MAX_MAP_CONCURRENCY). This
 *   deliberately only reports the declared *concurrency bound* (a real,
 *   build-time-known figure -- the most in-flight items runInline will ever
 *   run for that step), not a total invocation count: how many items an
 *   array-shaped input actually has (e.g. past `unzip`'s `handle[]` output)
 *   is runtime data no structural pass can see, so this refuses to estimate
 *   further rather than guess (#361's own framing).
 * - `maxRetryMultiplier`: Σ(retries+1) across every governed call site --
 *   every `leaf` (any `kind`; LeafOpts.retries applies regardless, see
 *   CLAUDE.md's governor-convention note) plus every `sink` target (each
 *   resolves its own effective opts: a target's own `opts.retries` if given,
 *   else the sink node's `opts.retries`, matching buildOpNode's `sink.fanout`
 *   wiring). This is the worst-case count of attempts a full run could burn
 *   across the whole tree. A `leaf` node carrying `params` adds one more --
 *   buildOpNode (./spec.ts) inserts a synthetic `retries: 0` mergeOp ahead of
 *   the real leaf when `params` is present, and that mergeOp is itself a
 *   governed call site (one real attempt at run time).
 * - `usesAsk`/`usesCache`/`usesLlm`/`llmLeaves`/`sinkTargets`: which optional
 *   `Caps` fields (`Caps.ask`, `Caps.cache`, `Caps.llm`, `Caps.sinks`) the
 *   spec will actually reach if run -- `ask`/`sinks` are visible directly on
 *   the spec shape, `cache` is any leaf/sink target opting into `memo`, and
 *   `llm` comes from LEAF_CAPS (./registry.ts), the small leaf->capability
 *   table kept alongside LEAF_SHAPES for this purpose.
 *
 * Never builds the actual Op tree or touches caps.store/llm/sinks, the same
 * purely-structural contract validateOpSpec documents. Assumes a
 * structurally well-formed spec -- a malformed node (missing `steps`/`op`/
 * `targets`, an unrecognized `tag`, ...) is silently skipped rather than
 * duplicating every one of validateOpSpec's error messages; callers that
 * also need structural-error checking should call validateOpSpec first.
 */
export function planOpSpec(spec: OpSpec): OpPlan {
  const plan: OpPlan = {
    nodeCount: 0,
    maxConcurrency: 0,
    maxRetryMultiplier: 0,
    usesAsk: false,
    usesCache: false,
    usesLlm: false,
    llmLeaves: [],
    sinkTargets: [],
  }
  const llmLeaves = new Set<string>()
  const sinkTargets = new Set<string>()
  walkPlan(spec, plan, llmLeaves, sinkTargets)
  plan.llmLeaves = [...llmLeaves].sort()
  plan.sinkTargets = [...sinkTargets].sort()
  return plan
}

function walkPlan(spec: OpSpec, plan: OpPlan, llmLeaves: Set<string>, sinkTargets: Set<string>): void {
  if (!spec || typeof spec !== 'object') return
  plan.nodeCount++
  switch (spec.tag) {
    case 'leaf': {
      if (typeof spec.name !== 'string' || !spec.name) return
      plan.maxRetryMultiplier += (spec.opts?.retries ?? 0) + 1
      if (spec.params) plan.maxRetryMultiplier += 1
      if (spec.opts?.memo) plan.usesCache = true
      if (LEAF_CAPS[spec.name]?.includes('llm')) {
        plan.usesLlm = true
        llmLeaves.add(spec.name)
      }
      return
    }
    case 'pipe': {
      if (!Array.isArray(spec.steps)) return
      for (const step of spec.steps) walkPlan(step, plan, llmLeaves, sinkTargets)
      return
    }
    case 'map':
    case 'mapField': {
      if (Number.isInteger(spec.concurrency) && spec.concurrency > plan.maxConcurrency) plan.maxConcurrency = spec.concurrency
      if (spec.op) walkPlan(spec.op, plan, llmLeaves, sinkTargets)
      return
    }
    case 'sink': {
      if (!Array.isArray(spec.targets)) return
      for (const target of spec.targets) {
        const name = typeof target === 'string' ? target : target?.name
        const targetOpts = typeof target === 'string' ? undefined : target?.opts
        if (typeof name !== 'string' || !name) continue
        sinkTargets.add(name)
        // Per-field fallback to the fanout's own opts, mirroring runInline's
        // 'sink' case (src/runtime/inline.ts) exactly -- a target that only
        // overrides `memo` still falls back to the node-level `retries`,
        // not to zero.
        const retries = targetOpts?.retries ?? spec.opts?.retries ?? 0
        const memo = targetOpts?.memo ?? spec.opts?.memo
        plan.maxRetryMultiplier += retries + 1
        if (memo) plan.usesCache = true
      }
      return
    }
    case 'catch': {
      if (spec.try) walkPlan(spec.try, plan, llmLeaves, sinkTargets)
      if (spec.catch) walkPlan(spec.catch, plan, llmLeaves, sinkTargets)
      return
    }
    case 'ask': {
      plan.usesAsk = true
      return
    }
    case 'reconcile':
    default:
      return
  }
}
