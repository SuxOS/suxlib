import { describe, expect, it } from 'vitest'
import { describePipelineSchema } from '../../src/op/introspect.js'
import { LEAF_SHAPES } from '../../src/op/registry.js'

describe('describePipelineSchema', () => {
  it('reports every built-in leaf\'s declared shape, every built-in sink, and the reconcile grammar', () => {
    const schema = describePipelineSchema()
    expect(schema.leaves.convert).toEqual(LEAF_SHAPES.convert)
    expect(Object.keys(schema.leaves).sort()).toEqual(Object.keys(LEAF_SHAPES).sort())
    expect(schema.sinks).toEqual(['store'])
    expect(schema.reconcileModes).toEqual(['faithful-union', 'last-write-wins', 'field-merge'])
    expect(schema.fieldPolicies).toEqual(['last-write-wins', 'union', 'keep-first'])
  })

  it('merges host-registered extraLeaves/extraSinks alongside the built-ins, reporting \'unknown\' shape for a leaf with no LEAF_SHAPES entry', () => {
    const schema = describePipelineSchema(
      { shout: async (input) => input },
      { log: { name: 'log', write: async (v) => v } },
    )
    expect(schema.leaves.shout).toEqual({ input: 'unknown', output: 'unknown' })
    expect(schema.sinks.sort()).toEqual(['log', 'store'])
  })
})
