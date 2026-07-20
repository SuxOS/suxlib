import { test, expect } from 'vitest'
import {
  detectFormat,
  toYaml,
  parseYaml,
  parseCsv,
  csvToRows,
  toCsv,
  toXml,
  parseXml,
  decodeEntities,
  parseSource,
  dispatchTransform,
  htmlToMarkdown,
  markdownToHtml,
  MAX_TRANSFORM_INPUT_BYTES,
  MAX_TRANSFORM_DEPTH,
  convert,
} from '../../src/domain/transform.js'
import { MemoryStore } from '../../src/effects/types.js'
import { putText, resolveText } from '../../src/handles/handle.js'

test('detectFormat recognizes json/yaml/csv/xml, including bare scalars and header-only csv', () => {
  expect(detectFormat('42')).toBe('json')
  expect(detectFormat('name: Ada')).toBe('yaml')
  expect(detectFormat('a,b,c')).toBe('csv')
  expect(detectFormat('<a/>')).toBe('xml')
})

test('toYaml/parseYaml round-trip objects, arrays, and multiline strings', () => {
  const obj = { note: 'line1\nline2', list: [1, 2, { nested: true }] }
  expect(parseYaml(toYaml(obj))).toEqual(obj)
})

test('parseYaml and parseXml guard against prototype pollution via __proto__ keys', () => {
  const y = parseYaml('__proto__:\n  polluted: true\nq: hi') as Record<string, unknown>
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(Object.getPrototypeOf(y)).toBe(Object.prototype)
  expect(y).toEqual({ q: 'hi' })

  const x = parseXml('<root><__proto__><polluted>true</polluted></__proto__><q>hi</q></root>') as Record<string, unknown>
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  const root = x.root as Record<string, unknown>
  expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
  expect(root).toEqual({ q: 'hi' })
})

test('parseXml parses a lone element named like an Object.prototype member instead of corrupting it', () => {
  const x = parseXml('<root><toString>hello</toString><hasOwnProperty>world</hasOwnProperty></root>') as Record<string, unknown>
  expect(x.root).toEqual({ toString: 'hello', hasOwnProperty: 'world' })
})

test('parseCsv keeps a quoted-empty row but drops a truly blank line', () => {
  expect(parseCsv('a\n""\nb\n', ',')).toEqual([['a'], [''], ['b']])
  expect(parseCsv('a\n\nb\n', ',')).toEqual([['a'], ['b']])
})

test('parseCsv strips a leading UTF-8 BOM instead of baking it into the first field', () => {
  expect(parseCsv('﻿name,age\nAda,36\n', ',')).toEqual([
    ['name', 'age'],
    ['Ada', '36'],
  ])
  expect(csvToRows('﻿name,age\nAda,36\n', ',')).toEqual([{ name: 'Ada', age: '36' }])
})

test('csvToRows suffixes duplicate headers until unique', () => {
  expect(csvToRows('a,a\n1,2\n', ',')).toEqual([{ a: '1', a_2: '2' }])
  expect(csvToRows('a,a,a_2\n1,2,3\n', ',')).toEqual([{ a: '1', a_2: '2', a_2_2: '3' }])
})

test('toCsv escapes a regex-metachar delimiter without throwing, and guards formula injection', () => {
  expect(toCsv([{ a: 'x-y' }], '-')).toBe('a\n"x-y"')
  expect(toCsv([{ cmd: '=cmd()' }], ',')).toBe("cmd\n'=cmd()")
  expect(toCsv([{ n: -5 }], ',')).toBe('n\n-5')
})

test('toCsv folds scalars in a mixed scalar/object array into a synthetic value column instead of dropping them', () => {
  expect(toCsv(['a', { b: 1 }], ',')).toBe('value,b\na,\n,1')
})

test('toCsv emits a single value column for an array of scalars instead of dropping the data', () => {
  expect(toCsv(['a', 'b', 'c'], ',')).toBe('value\na\nb\nc')
  expect(toCsv([1, 2, 3], ',')).toBe('value\n1\n2\n3')
})

test('toXml sanitizes a digit-leading key without colliding into the same tag as a distinct underscore-leading key', () => {
  const obj = { '123abc': 1, _123abc: 2 }
  const xml = toXml(obj, 'root')
  const parsed = parseXml(xml) as Record<string, Record<string, unknown>>
  const values = Object.values(parsed.root)
  // Two distinct source keys must not be merged into one array-valued tag.
  expect(values).toHaveLength(2)
  expect(new Set(values.map(String))).toEqual(new Set(['1', '2']))
})

test('toXml sanitizes two keys that differ only in their invalid characters without colliding onto the same tag', () => {
  const obj = { 'a>b': 1, 'a<b': 2 }
  const xml = toXml(obj, 'root')
  const parsed = parseXml(xml) as Record<string, Record<string, unknown>>
  const values = Object.values(parsed.root)
  // Two distinct source keys must not be merged into one array-valued tag.
  expect(values).toHaveLength(2)
  expect(new Set(values.map(String))).toEqual(new Set(['1', '2']))
})

test('toXml sanitizes a key containing a literal underscore without colliding with a key whose invalid char hex-escapes to the same text', () => {
  const obj = { 'a_3eb': 1, 'a>b': 2 }
  const xml = toXml(obj, 'root')
  const parsed = parseXml(xml) as Record<string, Record<string, unknown>>
  const values = Object.values(parsed.root)
  expect(values).toHaveLength(2)
  expect(new Set(values.map(String))).toEqual(new Set(['1', '2']))
})

test('toXml escapes attribute quotes and parseXml round-trips them', () => {
  const obj = { n: { '@id': 'a"b', '#text': 'hi' } }
  const xml = toXml(obj)
  expect(xml).toBe('<n id="a&quot;b">hi</n>')
  expect(parseXml(xml)).toEqual(obj)
})

test('toXml preserves a key whose value is an empty array instead of silently dropping it, and parseXml round-trips it back to []', () => {
  const obj = { a: 1, tags: [] as unknown[] }
  const xml = toXml(obj, 'root')
  expect(xml).toBe('<root><a>1</a><tags sux:empty-array="true"/></root>')
  expect(parseXml(xml)).toEqual({ root: { a: '1', tags: [] } })
})

test('toXml preserves a key whose value is a single-element array, and parseXml round-trips it back to a 1-element array instead of a bare scalar', () => {
  const obj = { tags: ['a'] }
  const xml = toXml(obj, 'root')
  expect(xml).toBe('<root><tags sux:single-array="true">a</tags></root>')
  expect(parseXml(xml)).toEqual({ root: { tags: ['a'] } })
})

test('toXml marks a null value distinctly from an empty-string scalar, and parseXml round-trips it back to null instead of ""', () => {
  const obj = { a: null }
  const xml = toXml(obj, 'root')
  expect(xml).toBe('<root><a sux:null-value="true"/></root>')
  expect(parseXml(xml)).toEqual({ root: { a: null } })
  expect(parseXml('<root><a></a></root>')).not.toEqual(parseXml(xml))
})

test('toXml/parseXml round-trip a real attribute whose key collides with the single-array marker word', () => {
  const obj = { row: { '@single-array': 'true', value: 'x' } }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip a real attribute whose key collides with the nested-array marker word', () => {
  const obj = { row: { '@nested-array': 'true', value: 'x' } }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip a real attribute whose key collides with the empty-array marker word', () => {
  const obj = { row: { '@empty-array': 'true' } }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip a real attribute whose key collides with the null-value marker word', () => {
  const obj = { row: { '@null-value': 'true' } }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip a single-element array containing null', () => {
  const obj = { tags: [null] }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip a single-element array of objects', () => {
  const obj = { items: [{ id: '1' }] }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip an array-of-arrays instead of silently flattening it', () => {
  const obj = { a: [['1', '2'], ['3', '4']] }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip an array-of-arrays whose sub-arrays have varying length, including single-element and empty sub-arrays', () => {
  const obj = { a: [['1'], [], ['2', '3'], ['4']] }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip a doubly-nested array (array of array of arrays)', () => {
  const obj = { a: [[['1', '2']], ['3']] }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('toXml/parseXml round-trip an array mixing plain values and nested arrays', () => {
  const obj = { a: [['1', '2'], '3', ['4']] }
  const xml = toXml(obj, 'root')
  expect(parseXml(xml)).toEqual({ root: obj })
})

test('parseXml does not truncate a tag at a `>` inside a quoted attribute value', () => {
  expect(parseXml('<tag attr="a>b">text</tag>')).toEqual({ tag: { '@attr': 'a>b', '#text': 'text' } })
})

test('parseXml strips a DOCTYPE with an internal DTD subset in full, not just up to its first `>`', () => {
  expect(parseXml('<!DOCTYPE root [<!ELEMENT root (#PCDATA)>]><root>hi</root>')).toEqual({ root: 'hi' })
})

test('decodeEntities decodes named and numeric entities, and survives an out-of-range numeric entity', () => {
  expect(decodeEntities('a &amp; b &lt;c&gt; &#39;')).toBe("a & b <c> '")
  expect(decodeEntities('&#99999999;')).toBe('&#99999999;')
})

test('decodeEntities decodes in a single pass, so a numeric entity decoding to "&" is not re-scanned by the &amp; decode', () => {
  expect(decodeEntities('&#38;amp;')).toBe('&amp;')
  expect(decodeEntities('Ben &#38;amp; Jerry')).toBe('Ben &amp; Jerry')
})

test('toYaml/toXml refuse to recurse past MAX_TRANSFORM_DEPTH', () => {
  let deep: unknown = 'leaf'
  for (let i = 0; i < MAX_TRANSFORM_DEPTH + 5; i++) deep = { n: deep }
  expect(() => toYaml(deep)).toThrow(/bomb guard/)
  expect(() => toXml(deep)).toThrow(/bomb guard/)
})

test('parseSource dispatches on the declared format', () => {
  expect(parseSource('{"a":1}', 'json')).toEqual({ a: 1 })
  expect(parseSource('a,b\n1,2\n', 'csv')).toEqual([{ a: '1', b: '2' }])
})

test('dispatchTransform converts across every declared format pair, including markdown<->html', () => {
  expect(dispatchTransform('a,b\n1,2\n', 'csv', 'json')).toBe(JSON.stringify([{ a: '1', b: '2' }], null, 2))
  expect(dispatchTransform('# Title', 'markdown', 'html')).toBe('<h1>Title</h1>')
  expect(dispatchTransform('<h1>Title</h1>', 'html', 'markdown')).toBe('# Title')
})

test('dispatchTransform rejects mixing markdown/html with the structured formats', () => {
  expect(() => dispatchTransform('# t', 'markdown', 'json')).toThrow(/only convert to each other/)
})

test('dispatchTransform rejects input over MAX_TRANSFORM_INPUT_BYTES', () => {
  const big = 'a'.repeat(MAX_TRANSFORM_INPUT_BYTES + 1)
  expect(() => dispatchTransform(big, 'json', 'json')).toThrow(/bomb guard/)
})

test('convert (Handle-based leaf) round-trips data through a Store via dispatchTransform', async () => {
  const store = new MemoryStore()
  const handle = await putText(store, '{"a":1}')
  const outHandle = await convert({ handle, from: 'json', to: 'yaml' }, { store } as any)
  expect(await resolveText(store, outHandle)).toBe('a: 1')
})

test('markdownToHtml sanitizes an unsafe link scheme to a harmless anchor', () => {
  const html = markdownToHtml('[click me](javascript:alert(1))')
  expect(html).not.toContain('javascript:')
  expect(html).toContain('href="#"')
})

test('markdownToHtml does not let emphasis regexes corrupt an underscore/asterisk in a link href', () => {
  const html = markdownToHtml('[click here](http://example.com/foo_bar_baz)')
  expect(html).toContain('<a href="http://example.com/foo_bar_baz">click here</a>')
})

test('htmlToMarkdown converts headings, lists, links, and code', () => {
  const md = htmlToMarkdown('<h1>Hi</h1><ul><li>one</li><li>two</li></ul><a href="https://x.test">link</a>')
  expect(md).toContain('# Hi')
  expect(md).toContain('- one')
  expect(md).toContain('[link](https://x.test)')
})

test('htmlToMarkdown does not double-decode doubly-encoded entities inside inline tags', () => {
  expect(dispatchTransform('<strong>&amp;#65;</strong>', 'html', 'markdown')).toBe('**&#65;**')
  expect(dispatchTransform('<p>plain &amp;amp; text</p>', 'html', 'markdown')).toBe('plain &amp; text')
})

test('htmlToMarkdown widens the inline-code delimiter so a backtick in the content cannot close it early', () => {
  const md = htmlToMarkdown('<p>Run <code>1 ` 2</code> now</p>')
  expect(md).toContain('``1 ` 2``')
})

test('htmlToMarkdown widens a <pre> fence so a backtick run in the content cannot close it early', () => {
  const md = htmlToMarkdown('<pre>```\nfenced\n```</pre>')
  expect(md).toContain('````\n``` fenced ```\n````')
})
