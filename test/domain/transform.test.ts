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
} from '../../src/domain/transform.js'

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

test('parseCsv keeps a quoted-empty row but drops a truly blank line', () => {
  expect(parseCsv('a\n""\nb\n', ',')).toEqual([['a'], [''], ['b']])
  expect(parseCsv('a\n\nb\n', ',')).toEqual([['a'], ['b']])
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

test('toCsv emits a single value column for an array of scalars instead of dropping the data', () => {
  expect(toCsv(['a', 'b', 'c'], ',')).toBe('value\na\nb\nc')
  expect(toCsv([1, 2, 3], ',')).toBe('value\n1\n2\n3')
})

test('toXml escapes attribute quotes and parseXml round-trips them', () => {
  const obj = { n: { '@id': 'a"b', '#text': 'hi' } }
  const xml = toXml(obj)
  expect(xml).toBe('<n id="a&quot;b">hi</n>')
  expect(parseXml(xml)).toEqual(obj)
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

test('markdownToHtml sanitizes an unsafe link scheme to a harmless anchor', () => {
  const html = markdownToHtml('[click me](javascript:alert(1))')
  expect(html).not.toContain('javascript:')
  expect(html).toContain('href="#"')
})

test('htmlToMarkdown converts headings, lists, links, and code', () => {
  const md = htmlToMarkdown('<h1>Hi</h1><ul><li>one</li><li>two</li></ul><a href="https://x.test">link</a>')
  expect(md).toContain('# Hi')
  expect(md).toContain('- one')
  expect(md).toContain('[link](https://x.test)')
})
