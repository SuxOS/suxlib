// Format transform core: json/yaml/csv/xml/markdown/html. Pure — no I/O.
// Ported from sux-fileops's src/core/transform.ts during the suxlib absorption
// of sux-fileops, itself ported from sux's src/fns/_convert.ts (json/yaml/csv/xml)
// and src/fns/_markup.ts (markdown<->html + shared entity decoder). This merge
// reconciles the two forks' independent hardening: fileops's bomb guards
// (MAX_TRANSFORM_INPUT_BYTES / MAX_TRANSFORM_DEPTH) and markdown-link scheme
// allowlist, plus sux's prototype-pollution guards (YAML/XML __proto__), safer
// numeric-entity decoding, and more defensive CSV delimiter escaping/header
// dedup — so no caller regresses on either fork's fixes.

import type { LeafFn } from '../op/types.js'
import type { Handle } from '../effects/types.js'
import { resolveText, putText } from '../handles/handle.js'

export type Format = 'json' | 'yaml' | 'csv' | 'xml' | 'markdown' | 'html'

/** All valid `to`/`from` values, shared by the CLI/HTTP/MCP adapters so `from`
 *  validation can't drift out of sync between them (see mcp.ts's `z.enum`). */
export const TRANSFORM_FORMATS = ['json', 'yaml', 'csv', 'xml', 'markdown', 'html'] as const satisfies readonly Format[]

/** Cap input size before parsing/traversing it, mirroring archive.ts's MAX_UNPACK_BYTES
 *  and pdf.ts's MAX_PDF_INPUT_BYTES bomb guards. */
export const MAX_TRANSFORM_INPUT_BYTES = 20_000_000
/** Cap recursion depth when walking a parsed JSON/YAML/XML object graph, so a
 *  deeply nested payload (e.g. `[[[[...]]]]` thousands of levels deep) can't
 *  blow the call stack. */
export const MAX_TRANSFORM_DEPTH = 100

/** Best-effort source-format detection for `from: auto` (json/yaml/csv/xml only). */
export function detectFormat(s: string): 'json' | 'yaml' | 'csv' | 'xml' {
  const t = s.trim()
  if (!t) return 'json'
  if (t.startsWith('<')) return 'xml'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (/^\s*[\w.-]+\s*:(\s|$)/m.test(t) || /^\s*-\s/m.test(t)) return 'yaml'
  try {
    const v = JSON.parse(t)
    if (v === null || typeof v !== 'object') return 'json'
  } catch {
    /* not a JSON scalar — fall through */
  }
  if (/^[^\n]*,[^\n]*(\n|$)/.test(t)) return 'csv'
  return 'yaml'
}

// ---------- JSON <-> YAML (practical common subset) ----------

function needsQuote(s: string): boolean {
  if (s === '') return true
  if (/^(true|false|null|~)$/i.test(s)) return true
  if (/^-?\d+(\.\d+)?$/.test(s)) return true
  return /[:#\[\]{}&*!|>'"%@`,\n\r\t]|^[\s?-]|\s$/.test(s)
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return '[]'
  if (typeof v === 'object') return '{}'
  const s = String(v)
  return needsQuote(s) ? JSON.stringify(s) : s
}

function yamlKey(k: string): string {
  return needsQuote(k) ? JSON.stringify(k) : k
}

export function toYaml(v: unknown, indent = 0): string {
  if (indent > MAX_TRANSFORM_DEPTH) throw new Error(`transform nests more than ${MAX_TRANSFORM_DEPTH} levels deep (bomb guard).`)
  const pad = '  '.repeat(indent)
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[]`
    return v
      .map((item) => {
        if (item !== null && typeof item === 'object' && Object.keys(item as object).length) {
          const block = toYaml(item, indent + 1)
          return `${pad}-${block.slice(pad.length + 1)}`
        }
        return `${pad}- ${yamlScalar(item)}`
      })
      .join('\n')
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object)
    if (!keys.length) return `${pad}{}`
    return keys
      .map((k) => {
        const val = (v as Record<string, unknown>)[k]
        if (val !== null && typeof val === 'object' && Object.keys(val as object).length) {
          return `${pad}${yamlKey(k)}:\n${toYaml(val, indent + 1)}`
        }
        return `${pad}${yamlKey(k)}: ${yamlScalar(val)}`
      })
      .join('\n')
  }
  return `${pad}${yamlScalar(v)}`
}

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?(0|[1-9]\d*)$/.test(s)) {
    const n = parseInt(s, 10)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s[0] === '"') {
      try {
        return JSON.parse(s)
      } catch {
        return s.slice(1, -1)
      }
    }
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s)
    } catch {
      /* fall through */
    }
  }
  return s
}

export function parseYaml(text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
    .map((l) => (/["']/.test(l) ? l : l.replace(/\s+#.*$/, '')))
    .map((l) => l.replace(/\s+$/, ''))

  let i = 0
  const indentOf = (l: string) => l.match(/^\s*/)![0].length

  function parseBlock(minIndent: number, depth = 0): unknown {
    if (depth > MAX_TRANSFORM_DEPTH) throw new Error(`transform nests more than ${MAX_TRANSFORM_DEPTH} levels deep (bomb guard).`)
    const first = lines[i]
    if (first === undefined) return null
    if (/^\s*-(\s|$)/.test(first)) return parseSeq(minIndent, depth)
    return parseMap(minIndent, depth)
  }
  function parseSeq(minIndent: number, depth: number): unknown[] {
    const arr: unknown[] = []
    while (i < lines.length) {
      const line = lines[i]
      const ind = indentOf(line)
      if (ind < minIndent || !/^\s*-(\s|$)/.test(line)) break
      const rest = line.slice(ind + 1).replace(/^\s*/, '')
      i++
      if (rest === '') {
        arr.push(parseBlock(ind + 1, depth + 1))
      } else if (/^[^"'\[{][^:]*:(\s|$)/.test(rest)) {
        const m = rest.match(/^([^:]+):\s*(.*)$/)!
        const obj: Record<string, unknown> = {}
        const childIndent = ind + 2
        const key = m[1].trim()
        const dangerous = key === '__proto__' || key === 'constructor' || key === 'prototype'
        if (m[2].trim() === '') {
          const block = parseBlock(childIndent, depth + 1)
          if (!dangerous) obj[key] = block
        } else if (!dangerous) obj[key] = parseScalar(m[2])
        mergeMap(obj, childIndent, depth + 1)
        arr.push(obj)
      } else {
        arr.push(parseScalar(rest))
      }
    }
    return arr
  }
  function parseMap(minIndent: number, depth: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    mergeMap(obj, minIndent, depth)
    return obj
  }
  function splitKey(line: string): { key: string; rest: string } | null {
    const body = line.slice(indentOf(line))
    const q = body[0]
    if (q === '"' || q === "'") {
      let j = 1
      for (; j < body.length; j++) {
        if (q === '"' && body[j] === '\\') j++
        else if (body[j] === q) {
          if (q === "'" && body[j + 1] === "'") j++
          else break
        }
      }
      const after = body.slice(j + 1).replace(/^\s*/, '')
      if (after[0] !== ':') return null
      return { key: String(parseScalar(body.slice(0, j + 1))), rest: after.slice(1) }
    }
    const m = body.match(/^([^:]+?):\s*(.*)$/)
    return m ? { key: m[1].trim(), rest: m[2] } : null
  }
  function mergeMap(obj: Record<string, unknown>, minIndent: number, depth: number) {
    while (i < lines.length) {
      const line = lines[i]
      const ind = indentOf(line)
      if (ind < minIndent || /^\s*-(\s|$)/.test(line.slice(ind))) break
      const kv = splitKey(line)
      if (!kv) break
      i++
      const key = kv.key
      // obj[key] = ... on "__proto__" invokes the Object.prototype setter and
      // repoints obj's prototype to attacker-controlled YAML content; still
      // parse the value (to consume its lines) but drop the assignment.
      const dangerous = key === '__proto__' || key === 'constructor' || key === 'prototype'
      if (kv.rest.trim() === '') {
        const next = lines[i]
        const seqAtKeyIndent = next !== undefined && indentOf(next) === ind && /^\s*-(\s|$)/.test(next)
        const block = parseBlock(seqAtKeyIndent ? ind : ind + 1, depth + 1)
        if (!dangerous) obj[key] = block
      } else if (!dangerous) obj[key] = parseScalar(kv.rest)
    }
  }
  return parseBlock(0)
}

// ---------- JSON <-> CSV (RFC4180-ish) ----------

export function parseCsv(text: string, delim: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  const nonBlank: boolean[] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  let started = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    nonBlank.push(started)
    row = []
    started = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += c
      continue
    }
    if (c === '"') {
      inQ = true
      started = true
    } else if (c === delim) {
      pushField()
      started = true
    } else if (c === '\n') {
      pushRow()
    } else if (c === '\r') {
      if (text[i + 1] !== '\n') pushRow()
    } else {
      field += c
      started = true
    }
  }
  if (started || field.length || row.length) pushRow()
  return rows.filter((r, i) => !(r.length === 1 && r[0] === '' && !nonBlank[i]))
}

/** CSV text -> array of row objects (first row = headers). Duplicate header
 *  names are suffixed `_N`, climbing until unique against names already
 *  emitted — so [a, a, a_2] doesn't collide into a dropped column. */
export function csvToRows(text: string, delim: string): Record<string, string>[] {
  const rows = parseCsv(text, delim)
  if (!rows.length) return []
  const used = new Set<string>()
  const headers = rows[0].map((h) => {
    if (!used.has(h)) {
      used.add(h)
      return h
    }
    let n = 2
    let name = `${h}_${n}`
    while (used.has(name)) name = `${h}_${++n}`
    used.add(name)
    return name
  })
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
}

export function toCsv(arr: unknown[], delim: string): string {
  delim = (delim || ',').slice(0, 1)
  if (!arr.length) return ''
  const esc = (v: unknown): string => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    // Escape every char-class metachar in `delim` — including `-`, which would
    // otherwise form an out-of-order range (e.g. `["-\r\n]`) and throw.
    return new RegExp(`["${delim.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\r\\n]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // Scalars (not objects) have no keys to derive a header from — emit a
  // single synthetic `value` column instead of silently dropping every row.
  if (arr.every((o) => o === null || typeof o !== 'object')) {
    return ['value', ...arr.map((v) => esc(v))].join('\n')
  }
  // Mixed scalar/object arrays: scalar entries have no keys either, but unlike
  // the pure-scalar case above there are real object keys to preserve too — fold
  // scalars into the same synthetic `value` column instead of dropping them.
  const headers = [...new Set(arr.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o as object) : ['value'])))]
  const lines = [headers.map((h) => esc(h)).join(delim)]
  for (const o of arr) {
    const row = o && typeof o === 'object' ? (o as Record<string, unknown>) : { value: o }
    lines.push(headers.map((h) => esc(row[h])).join(delim))
  }
  return lines.join('\n')
}

// ---------- JSON <-> XML ----------

const NAMED_ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }
const ENTITY_RE = /&nbsp;|&lt;|&gt;|&quot;|&apos;|&amp;|&#x([0-9a-f]+);|&#(\d+);/gi

/**
 * Canonical HTML/XML entity decoder — named entities plus general numeric
 * forms, all decoded in a single combined-regex pass (not chained separate
 * `.replace()` calls) so a freshly-decoded fragment (e.g. `&#38;` decoding to
 * a literal `&`) can never be re-scanned and collapsed by a later step —
 * entity decoding is one scan over the source markup, not a re-scan of
 * already-decoded output.
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, hex, dec) => {
    const named = NAMED_ENTITIES[m.toLowerCase()]
    if (named !== undefined) return named
    if (hex !== undefined) return fromCodePointSafe(parseInt(hex, 16), m)
    return fromCodePointSafe(parseInt(dec, 10), m)
  })
}

// String.fromCodePoint throws RangeError for values > U+10FFFF (or negative), which
// would abort the whole decode over a single malformed entity. Fall back to the raw
// entity text so one bad numeric entity can't take down the conversion.
function fromCodePointSafe(cp: number, raw: string): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return raw
  return String.fromCodePoint(cp)
}

function encodeEntitiesXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Sanitize an object key before using it as an XML tag/attribute name: names
 * may only contain `[A-Za-z0-9_.-]` and can't start with a digit, `.`, or `-`
 * (those are valid mid-name but not as the first char). Every character
 * outside `[A-Za-z0-9.-]` -- including a literal `_`, which is reserved below
 * as the escape delimiter -- is replaced by a self-delimited `_<hex>_` escape,
 * so `toXml` never interpolates a raw key into markup (without this a key
 * like `a><script>` would inject its own tag/attribute) *and* two distinct
 * keys that differ only in which invalid characters they contain (e.g. 'a>b'
 * vs 'a<b', which used to both collapse onto the bare substitute 'a_b' and
 * silently merge into one array-valued tag) can no longer collide: since a
 * literal `_` never survives un-escaped from the input, every `_` in `safe`
 * marks the start of a self-delimited escape block, so the key -> safe
 * mapping stays injective the same way the digit-prefix step below is.
 */
function xmlName(key: string): string {
  const safe = [...key].map(ch => (/[A-Za-z0-9.-]/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`)).join('')
  // Prefixing must apply whenever `safe` doesn't already start with a letter —
  // including when it already starts with `_` — or two distinct keys (e.g.
  // '123abc' and '_123abc') sanitize to the same escaped name. Unconditionally
  // prepending `_` for every non-letter-start case keeps the mapping injective:
  // it's a pure `s -> '_' + s` prefix, so distinct `safe` values can never collide.
  return /^[A-Za-z]/.test(safe) ? safe : `_${safe}`
}

// attach()'s default promote-on-repeat heuristic (below) infers "already
// promoted to an array" purely from `Array.isArray(cur)` — which breaks the
// moment a *value itself* is an array (a single-array or nested-array child),
// since a lone occurrence's value looks identical to an already-promoted
// multi-occurrence accumulator. forceArrayKeys tracks, per parent node, which
// keys must always accumulate (rather than ever being inferred), so repeated
// array-valued siblings (see wrapNestedArray) don't get misread as a single
// promoted array and swallow later siblings into a wrong shape.
const forceArrayKeys = new WeakMap<object, Set<string>>()

function attach(node: Record<string, unknown>, name: string, child: unknown, forceArray = false) {
  // node[name] = ... on "__proto__" invokes the Object.prototype setter and
  // repoints node's prototype to attacker-controlled XML content.
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') return
  const forced = forceArrayKeys.get(node)
  if (forced?.has(name)) {
    ;(node[name] as unknown[]).push(child)
    return
  }
  if (Object.prototype.hasOwnProperty.call(node, name)) {
    const cur = node[name]
    if (Array.isArray(cur)) cur.push(child)
    else node[name] = [cur, child]
  } else if (forceArray) {
    node[name] = [child]
    if (forced) forced.add(name)
    else forceArrayKeys.set(node, new Set([name]))
  } else {
    node[name] = child
  }
}
function collapse(node: Record<string, unknown>): unknown {
  const keys = Object.keys(node)
  if (keys.length === 1 && keys[0] === '#text') return node['#text']
  return node
}

// All four marker attribute names below carry a literal `:` -- a character
// xmlName() (see above) always escapes to `_3a_` rather than passing through,
// since `:` fails xmlName's `[A-Za-z0-9.-]` safe-charset test. That makes
// `sux:...` unproducible as the *output* of xmlName(anyUserKey), so a real
// JSON attribute key (however it's spelled) can never sanitize to the same
// string as one of these markers and be silently mistaken for the internal
// control channel by parseXml. See issue #291 -- plain-word marker names
// (e.g. bare 'single-array') collided with a same-named real user attribute
// key, corrupting the round-trip.

// Self-closing marker attribute `toXml` emits for a JSON key whose value is an
// empty array — without it, `obj.map(...).join('')` over an empty array
// produces '', and the key vanishes from the output entirely instead of
// round-tripping (see toYaml's `[]` handling, which has no such gap since
// yamlScalar emits an explicit '[]' for empty arrays). `parseXml` looks for
// this same attribute to decode a self-closed tag back into [] rather than ''.
const EMPTY_ARRAY_ATTR = 'sux:empty-array'

// Marker attribute `toXml` emits on the sole element of a length-1 JSON array —
// without it, a 1-element array renders as exactly one sibling element, which is
// byte-identical to a plain scalar field of the same tag name, so parseXml (which
// only promotes a key to an array once it sees the tag repeated) silently turns
// the round-tripped value back into a scalar. See issue #68.
const SINGLE_ARRAY_ATTR = 'sux:single-array'

// Marker attribute `toXml` emits for a JSON key whose value is null/undefined —
// without it, a null field and an empty-string scalar field both render as the
// same self-closing `<tag/>`, so parseXml can't tell them apart and always
// decodes the tag back to ''. See issue #79.
const NULL_VALUE_ATTR = 'sux:null-value'

// Marker attribute `toXml` emits on an array element that is itself an array
// (array-of-arrays) — without it, `{a: [[1,2],[3,4]]}` recurses into the inner
// arrays using the *same* tag as the outer array, rendering byte-identical to
// (and round-tripping as) the fully flattened `{a: [1,2,3,4]}`. The marked
// element's children all use ARRAY_ITEM_TAG rather than the outer array's own
// tag, so parseXml can rebuild the inner array without it being mistaken for
// more siblings of the outer array. See issue #105.
const NESTED_ARRAY_ATTR = 'sux:nested-array'

// Fixed child tag `wrapNestedArray` renders a nested array's own elements
// under, keeping them distinct from the outer array's repeated tag name.
const ARRAY_ITEM_TAG = 'item'

function tagEnd(s: string, lt: number): number {
  let quote = ''
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i
    }
  }
  return -1
}

export function parseXml(xml: string): unknown {
  const src = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^\[>]*(\[[^\]]*\])?[^>]*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c) => encodeEntitiesXml(c))
  const root: Record<string, unknown> = {}
  const nodes: Record<string, unknown>[] = [root]
  const names: string[] = ['']
  let pos = 0
  while (pos < src.length) {
    const lt = src.indexOf('<', pos)
    if (lt === -1) break
    const text = src.slice(pos, lt)
    if (text.trim()) {
      const top = nodes[nodes.length - 1]
      top['#text'] = ((top['#text'] as string) ?? '') + decodeEntities(text).trim()
    }
    const gt = tagEnd(src, lt)
    if (gt === -1) throw new Error('unterminated tag')
    let tag = src.slice(lt + 1, gt).trim()
    if (tag.startsWith('/')) {
      const closing = tag.slice(1).trim()
      if (nodes.length < 2) throw new Error(`unexpected closing tag </${closing}>`)
      const expected = names[names.length - 1]
      if (closing !== expected) throw new Error(`mismatched tag: expected </${expected}>, got </${closing}>`)
      const finished = nodes.pop()!
      names.pop()
      const isSingleArray = finished['@' + SINGLE_ARRAY_ATTR] === 'true'
      if (isSingleArray) delete finished['@' + SINGLE_ARRAY_ATTR]
      const isNestedArray = finished['@' + NESTED_ARRAY_ATTR] === 'true'
      if (isNestedArray) delete finished['@' + NESTED_ARRAY_ATTR]
      const value = isNestedArray ? (finished[ARRAY_ITEM_TAG] ?? []) : collapse(finished)
      attach(nodes[nodes.length - 1], expected, value, isSingleArray || isNestedArray)
      pos = gt + 1
      continue
    }
    const selfClose = tag.endsWith('/')
    if (selfClose) tag = tag.slice(0, -1).trim()
    const name = tag.match(/^([\w:.-]+)/)?.[1]
    if (!name) throw new Error('malformed tag')
    const node: Record<string, unknown> = {}
    for (const a of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)) {
      const key = a[1] ?? a[3]
      const val = a[2] ?? a[4] ?? ''
      node['@' + key] = decodeEntities(val)
    }
    if (selfClose) {
      const isSingleArray = node['@' + SINGLE_ARRAY_ATTR] === 'true'
      if (isSingleArray) delete node['@' + SINGLE_ARRAY_ATTR]
      const isNestedArray = node['@' + NESTED_ARRAY_ATTR] === 'true'
      if (isNestedArray) delete node['@' + NESTED_ARRAY_ATTR]
      const isEmptyArray = Object.keys(node).length === 1 && node['@' + EMPTY_ARRAY_ATTR] === 'true'
      const isNullValue = Object.keys(node).length === 1 && node['@' + NULL_VALUE_ATTR] === 'true'
      const value = isEmptyArray ? [] : isNullValue ? null : Object.keys(node).length ? node : ''
      attach(nodes[nodes.length - 1], name, value, isSingleArray || isNestedArray)
    } else {
      nodes.push(node)
      names.push(name)
    }
    pos = gt + 1
  }
  if (nodes.length !== 1) throw new Error('unclosed tag(s)')
  return collapse(root)
}

// Injects the single-array marker attribute into an already-rendered element's
// opening tag, so the sole element of a length-1 array is indistinguishable from
// no other array elements in the output but still carries a signal parseXml can
// use to restore its array-ness. Every toXml element output starts with `<${tag}`
// (attrs and/or a self-close or content follow), so a plain prefix splice suffices.
function markSingleArray(xml: string, tag: string): string {
  const prefix = `<${tag}`
  return xml.startsWith(prefix) ? `${prefix} ${SINGLE_ARRAY_ATTR}="true"${xml.slice(prefix.length)}` : xml
}

// Renders an array-of-arrays element (`v` is itself an array) under the outer
// array's own tag, marked with NESTED_ARRAY_ATTR so parseXml treats the whole
// element as one array-typed sibling instead of flattening its children in
// with the outer array's. `v`'s own elements render under ARRAY_ITEM_TAG
// (delegated to toXml, which already handles v's own length-0/1/N cases)
// rather than the outer tag, so they can't be confused with more outer
// siblings during decode.
function wrapNestedArray(v: unknown[], tag: string, depth: number): string {
  if (!v.length) return `<${tag} ${NESTED_ARRAY_ATTR}="true" ${EMPTY_ARRAY_ATTR}="true"/>`
  return `<${tag} ${NESTED_ARRAY_ATTR}="true">${toXml(v, ARRAY_ITEM_TAG, depth + 1)}</${tag}>`
}

export function toXml(obj: unknown, name?: string, depth = 0): string {
  if (depth > MAX_TRANSFORM_DEPTH) throw new Error(`transform nests more than ${MAX_TRANSFORM_DEPTH} levels deep (bomb guard).`)
  if (obj === null || obj === undefined) return name ? `<${xmlName(name)} ${NULL_VALUE_ATTR}="true"/>` : ''
  if (Array.isArray(obj)) {
    if (!obj.length) return name ? `<${xmlName(name)} ${EMPTY_ARRAY_ATTR}="true"/>` : ''
    if (!name) return obj.map((v) => toXml(v, name, depth + 1)).join('')
    const tag = xmlName(name)
    const rendered = obj.map((v) => (Array.isArray(v) ? wrapNestedArray(v, tag, depth) : toXml(v, name, depth + 1)))
    return obj.length === 1 ? markSingleArray(rendered[0], tag) : rendered.join('')
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
    const attrs = entries
      .filter(([k]) => k.startsWith('@'))
      .map(([k, v]) => ` ${xmlName(k.slice(1))}="${encodeEntitiesXml(String(v)).replace(/"/g, '&quot;')}"`)
      .join('')
    const inner = entries
      .filter(([k]) => !k.startsWith('@'))
      .map(([k, v]) => (k === '#text' ? encodeEntitiesXml(String(v)) : toXml(v, xmlName(k), depth + 1)))
      .join('')
    const tag = name ? xmlName(name) : name
    if (!tag) return inner
    return inner === '' && attrs !== '' ? `<${tag}${attrs}/>` : `<${tag}${attrs}>${inner}</${tag}>`
  }
  const esc = encodeEntitiesXml(String(obj))
  const tag = name ? xmlName(name) : name
  return tag ? `<${tag}>${esc}</${tag}>` : esc
}

/** Parse any supported source string into a JS value. */
export function parseSource(data: string, from: 'json' | 'yaml' | 'csv' | 'xml', opts?: { delimiter?: string }): unknown {
  switch (from) {
    case 'json':
      return JSON.parse(data)
    case 'yaml':
      return parseYaml(data)
    case 'csv':
      return csvToRows(data, (opts?.delimiter ?? ',').slice(0, 1) || ',')
    case 'xml':
      return parseXml(data)
    default:
      throw new Error(`Unsupported source format '${from}'.`)
  }
}

/**
 * Shared transform dispatch: the single implementation of "convert `data` from
 * `from` to `to`" used identically by the CLI, HTTP, and MCP adapters (this is
 * what backs README.md's "no logic duplicated across CLI/HTTP/MCP" claim — each
 * adapter calls this instead of keeping its own copy).
 */
export function dispatchTransform(data: string, from: Format | 'auto', to: Format, delimiter = ','): string {
  if (data.length > MAX_TRANSFORM_INPUT_BYTES) {
    throw new Error(`transform input is larger than ${MAX_TRANSFORM_INPUT_BYTES} bytes (bomb guard).`)
  }
  if (from === 'markdown' && to === 'html') return markdownToHtml(data)
  if (from === 'html' && to === 'markdown') return htmlToMarkdown(data)
  if (from === 'markdown' || from === 'html' || to === 'markdown' || to === 'html') {
    throw new Error('markdown/html only convert to each other, not to json/yaml/csv/xml')
  }
  if (from === 'auto' && data.trim() === '') throw new Error('cannot transform empty input in auto mode — specify --from explicitly.')
  const sourceFormat = from === 'auto' ? detectFormat(data) : from
  const value = parseSource(data, sourceFormat, { delimiter })
  switch (to) {
    case 'json':
      return JSON.stringify(value, null, 2)
    case 'yaml':
      return toYaml(value)
    case 'csv':
      return toCsv(Array.isArray(value) ? value : [value], delimiter)
    case 'xml':
      // A top-level array would emit multiple sibling <root> elements
      // (malformed XML — the common CSV->XML case). Wrap it so there's
      // exactly one root, with each element under <item>.
      return toXml(Array.isArray(value) ? { item: value } : value, 'root')
    default:
      throw new Error(`Unsupported target format '${to}'.`)
  }
}

// ---------- Markdown <-> HTML ----------
// Common subset: headings, links, bold/em, lists, inline code, code blocks,
// blockquotes, paragraphs.

// Strips tags without decoding entities -- used for substitutions inside
// inlineToMd, which decodes entities exactly once, on the fully-assembled
// string, to avoid double-decoding already-decoded doubly-encoded content (#263).
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// Longest run of consecutive backticks in `s` -- used to size an inline-code
// delimiter or fence long enough that the content itself can't prematurely
// close it (CommonMark's own rule for choosing a backtick-run/fence length).
function longestBacktickRun(s: string): number {
  let longest = 0
  for (const run of s.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

function inlineText(s: string): string {
  return decodeEntities(stripTags(s))
}

function inlineToMd(s: string): string {
  return decodeEntities(
    s
      .replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${stripTags(txt)}](${href})`)
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${stripTags(txt)}**`)
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${stripTags(txt)}*`)
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, txt) => {
        const content = stripTags(txt)
        const delim = '`'.repeat(longestBacktickRun(content) + 1)
        const pad = content.startsWith('`') || content.endsWith('`') || content === '' ? ' ' : ''
        return `${delim}${pad}${content}${pad}${delim}`
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function listItems(html: string, ordered: boolean): string {
  const items: string[] = []
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  let n = 1
  while ((m = re.exec(html))) items.push(`${ordered ? `${n++}.` : '-'} ${inlineToMd(m[1])}`)
  return items.join('\n')
}

export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, txt) => `\x00${'#'.repeat(Number(lvl))} ${inlineToMd(txt)}\x00`)
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, txt) => {
    const inner = inlineText(txt.replace(/<code\b[^>]*>|<\/code>/gi, ''))
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(inner) + 1))
    return `\x00${fence}\n${inner}\n${fence}\x00`
  })
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, txt) =>
    `\x00${inlineToMd(txt).split('\n').map((l: string) => `> ${l}`.trimEnd()).join('\n')}\x00`,
  )
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, txt) => `\x00${listItems(txt, false)}\x00`)
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, txt) => `\x00${listItems(txt, true)}\x00`)
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, txt) => `\x00${inlineToMd(txt)}\x00`)
  s = s
    .split('\x00')
    .map((part, idx) => (idx % 2 === 1 ? part : inlineToMd(part)))
    .join('\n\n')
  return s
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .join('\n\n')
}

// Only these URL schemes are safe to emit in an href/src. Anything else
// (javascript:, data:, vbscript:, file:, etc.) is a stored-XSS vector once
// the generated HTML is rendered.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

function sanitizeUrl(raw: string): string {
  const url = raw.trim()
  // Strip ASCII control/whitespace chars (space, tab, CR, LF, etc.) -- browsers
  // ignore them inside a scheme, so javascript-with-embedded-tab is a classic
  // filter-bypass trick that must be neutralized before inspection.
  const stripped = url.replace(/[\x00-\x20]+/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(stripped)?.[1]
  // No scheme at all => relative/anchor/scheme-relative URL, which is safe.
  if (scheme && !SAFE_SCHEMES.has(scheme.toLowerCase() + ':')) return '#'
  return url.replace(/"/g, '&quot;')
}

// A regex href capture can't count balanced parens, so a URL like
// `https://en.wikipedia.org/wiki/Foo_(bar)` truncates at the link's own
// closing `)` (#310) -- scan the `(...)` span with a depth counter instead,
// which naturally handles any nesting depth rather than special-casing one
// level.
function replaceLinks(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1)
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        let depth = 1
        let j = closeBracket + 2
        while (j < s.length && depth > 0) {
          if (s[j] === '(') depth++
          else if (s[j] === ')') depth--
          if (depth === 0) break
          j++
        }
        if (depth === 0) {
          const txt = s.slice(i + 1, closeBracket)
          const href = s.slice(closeBracket + 2, j)
          out += `<a href="${sanitizeUrl(href)}">${txt}</a>`
          i = j + 1
          continue
        }
      }
    }
    out += s[i]
    i++
  }
  return out
}

function inlineMdToHtml(s: string): string {
  const codes: string[] = []
  return replaceLinks(
    encodeEntitiesXml(s)
      .replace(/`([^`]+)`/g, (_m, c) => `\x00${codes.push(`<code>${c}</code>`) - 1}\x00`),
  )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\x00(\d+)\x00/g, (_m, i) => codes[Number(i)])
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  const flushList = (items: string[], ordered: boolean) => {
    if (!items.length) return
    const tag = ordered ? 'ol' : 'ul'
    out.push(`<${tag}>${items.map((t) => `<li>${inlineMdToHtml(t)}</li>`).join('')}</${tag}>`)
  }
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre><code>${encodeEntitiesXml(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push(`<h${h[1].length}>${inlineMdToHtml(h[2].trim())}</h${h[1].length}>`)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${inlineMdToHtml(body.join(' ').trim())}</blockquote>`)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''))
      flushList(items, false)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''))
      flushList(items, true)
      continue
    }
    const para: string[] = []
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) {
      para.push(lines[i++])
    }
    out.push(`<p>${inlineMdToHtml(para.join(' ').trim())}</p>`)
  }
  return out.join('\n')
}

// convert: Handle-based wrapper around dispatchTransform, following
// archive.ts's pack/unpack, pdf.ts's shrink, and sanitize.ts's redact/scrub —
// resolve the input Handle, run the pure function, put the result back as a Handle.
export type ConvertInput = { handle: Handle; from: Format | 'auto'; to: Format; delimiter?: string }
export const convert: LeafFn = async (input, caps) => {
  const { handle, from, to, delimiter } = input as ConvertInput
  const data = await resolveText(caps.store, handle)
  const out = dispatchTransform(data, from, to, delimiter)
  return putText(caps.store, out)
}
