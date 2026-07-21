import type { LeafFn, SinkTarget } from './types.js'
import { LEAF_SHAPES, mergeLeaves, type LeafShape } from './registry.js'
import { SINK_REGISTRY } from './sinks.js'
import { FIELD_POLICIES, RECONCILE_MODES } from './spec.js'

export type PipelineSchema = {
  leaves: Record<string, { input: LeafShape; output: LeafShape }>
  sinks: string[]
  reconcileModes: readonly string[]
  fieldPolicies: readonly string[]
}

/**
 * Queryable, structured description of exactly what a valid OpSpec (./spec.ts)
 * can contain right now (#187) -- built from the same LEAF_SHAPES/
 * SINK_REGISTRY/FIELD_POLICIES/RECONCILE_MODES buildOp already validates
 * against, merged with any host-registered extraLeaves/extraSinks the same
 * host-overrides-built-in order mergeLeaves/op-run.ts's sinks merge already
 * use. Adapters expose this as `describe_pipeline` (mcp.ts), `GET /op/schema`
 * (http.ts), and `pipeline describe` (cli.ts) so a caller -- especially an LLM
 * composing a pipeline -- can discover a leaf's field-level shape instead of
 * guessing from prose or learning it by trial-and-error against buildOp's
 * runtime shape-mismatch errors. A leaf absent from LEAF_SHAPES (a
 * host-registered extraLeaves leaf with no declared shape) reports 'unknown'
 * on both sides, the same permissive default buildOp's own
 * shape-compatibility check already falls back to.
 */
export function describePipelineSchema(extraLeaves?: Record<string, LeafFn>, extraSinks?: Record<string, SinkTarget>): PipelineSchema {
  const leaves: Record<string, { input: LeafShape; output: LeafShape }> = {}
  for (const name of Object.keys(mergeLeaves(extraLeaves))) {
    leaves[name] = LEAF_SHAPES[name] ?? { input: 'unknown', output: 'unknown' }
  }
  const sinks = Object.keys(Object.assign(Object.create(null), SINK_REGISTRY, extraSinks))
  return { leaves, sinks, reconcileModes: RECONCILE_MODES, fieldPolicies: FIELD_POLICIES }
}
