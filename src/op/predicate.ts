// A deliberately non-Turing-complete predicate language for `cond`'s branch
// routing (#196): a caller-supplied JSON OpSpec can never carry arbitrary
// injected code (no safe `eval` in a stateless adapter call), so a `cond`
// branch's `when` is restricted to declarative field-equals/field-in/exists
// checks over the piped value's top-level fields, mirroring `catch`'s
// error-path routing but for the success path instead.
// `value`/`values` are optional in the type (not just at the call site) because a
// zod `z.unknown()` field infers as optional -- z.object({ value: z.unknown() })'s
// output type allows the key to be absent, since `unknown` admits `undefined` --
// so mcp.ts's condPredicateSchema and this type must agree on that or `opSpecSchema`
// fails to satisfy `ZodType<OpSpec>` at compile time.
export type CondPredicate =
  | { kind: 'eq'; field: string; value?: unknown }
  | { kind: 'in'; field: string; values: unknown[] }
  | { kind: 'exists'; field: string }

export function matchPredicate(pred: CondPredicate, input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const v = (input as Record<string, unknown>)[pred.field]
  switch (pred.kind) {
    case 'eq': return v === pred.value
    case 'in': return pred.values.includes(v)
    case 'exists': return v !== undefined
  }
}
