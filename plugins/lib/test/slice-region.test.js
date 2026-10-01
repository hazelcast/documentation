'use strict'

// plugins/lib/slice-region.js slices an example file to the region a page imports (`?tag=`, `?lines=`, `?indent=0`),
// for the build-time tag-slice loader. The tag markers and selection rules follow Asciidoctor's, which the examples
// were written for. Fixtures are hand-written and each assertion states the rule being reproduced.

const test = require('node:test')
const assert = require('node:assert/strict')
const {sliceRegion, allRegions, parseLineRanges, stripBom} = require('../slice-region')

test('tag: selects the lines between the markers, markers excluded', () => {
  const src = [
    'package demo;',
    'import java.util.Map;',
    '//tag::body[]',
    'public class A {',
    '    int x = 1;',
    '}',
    '//end::body[]',
    'class Trailing {}',
    '',
  ].join('\n')

  assert.equal(sliceRegion(src, {tag: 'body'}), 'public class A {\n    int x = 1;\n}\n')
  // The file stays compilable because what a compiler needs sits outside the region a reader sees.
  assert.ok(!sliceRegion(src, {tag: 'body'}).includes('package'))
  assert.ok(sliceRegion(src, null).includes('package demo;'), 'no selector is the whole file')
})

test('indentation and trailing whitespace inside a region are preserved, as in an Asciidoctor listing block', () => {
  const src = '//tag::t[]\n        a();\n        \n        b();\n//end::t[]\n'
  assert.equal(sliceRegion(src, {tag: 't'}), '        a();\n        \n        b();\n')
})

// Asciidoctor trims trailing blank lines off a listing block, and Docusaurus strips exactly one trailing newline.
test('trailing blank lines are dropped and exactly one final newline is left', () => {
  assert.equal(sliceRegion('//tag::t[]\na();\n\n\n//end::t[]\n', {tag: 't'}), 'a();\n')
  assert.equal(sliceRegion('//tag::t[]\n\n\n//end::t[]\n', {tag: 't'}), '', 'an all-blank region is empty')
})

test('a region never shows another region\'s markers, and a nested region is selectable in its own right', () => {
  const src = '//tag::outer[]\na();\n//tag::inner[]\nb();\n//end::inner[]\nc();\n//end::outer[]\n'
  assert.equal(sliceRegion(src, {tag: 'outer'}), 'a();\nb();\nc();\n')
  assert.equal(sliceRegion(src, {tag: 'inner'}), 'b();\n')
})

test('markers are recognised in //, <!-- --> and # comments', () => {
  const xml = '<config>\n  <!-- tag::realm[] -->\n  <realm name="r"/>\n  <!-- end::realm[] -->\n</config>\n'
  assert.equal(sliceRegion(xml, {tag: 'realm'}), '  <realm name="r"/>\n')
  assert.equal(sliceRegion('# tag::t[]\nkey: v\n# end::t[]\n', {tag: 't'}), 'key: v\n')
})

// A callout is written as a comment so the file compiles; Asciidoctor drops the comment marker and keeps <N>.
test('callouts: the comment marker is stripped, <N> kept, and other comments untouched', () => {
  assert.equal(sliceRegion('//tag::t[]\n@Bean // <1>\n    // <2>\n//end::t[]\n', {tag: 't'}), '@Bean <1>\n    <2>\n')
  assert.equal(
    sliceRegion('//tag::t[]\nurl = "http://x"; // not a callout\n//end::t[]\n', {tag: 't'}),
    'url = "http://x"; // not a callout\n',
  )
})

// `indent=0` is a listing-block attribute: whether a slice is reindented is a property of the page, not the file.
test('indent=0 removes the common indent and keeps relative nesting', () => {
  const src = '//tag::t[]\n        if (a) {\n            b();\n\n        }\n//end::t[]\n'
  assert.equal(sliceRegion(src, {tag: 't'}), '        if (a) {\n            b();\n\n        }\n')
  assert.equal(sliceRegion(src, {tag: 't', indent: '0'}), 'if (a) {\n    b();\n\n}\n')
})

test('lines= is 1-indexed and inclusive, with single lines, an open end and multiple ranges', () => {
  const src = ['one', 'two', 'three', 'four', 'five'].join('\n')
  assert.equal(sliceRegion(src, {lines: '2..3'}), 'two\nthree\n')
  assert.equal(sliceRegion(src, {lines: '4'}), 'four\n')
  assert.equal(sliceRegion(src, {lines: '4..-1'}), 'four\nfive\n')
  assert.equal(sliceRegion(src, {lines: '1;4'}), 'one\nfour\n')
  assert.deepEqual(parseLineRanges('2..3;5'), [[2, 3], [5, 5]])
})

// A page asking for a region that no longer exists must break the build: an empty code block would ship.
test('an absent tag, an unterminated region, a wildcard, an absent list or negation member and a bad range all throw', () => {
  assert.throws(() => sliceRegion('//tag::a[]\nx\n//end::a[]\n', {tag: 'gone'}, 'F.java'), /F\.java: no region tagged "gone"/)
  assert.throws(() => sliceRegion('//tag::a[]\nx\n', {tag: 'a'}), /never closed/)
  assert.throws(() => sliceRegion('//tag::a[]\nx\n//end::a[]\n', {tag: 'a;*'}), /wildcards are not supported/)
  assert.throws(() => sliceRegion('//tag::a[]\nx\n//end::a[]\n', {tag: 'a;b'}), /no region tagged "b"/)
  assert.throws(() => sliceRegion('//tag::a[]\nx\n//end::a[]\n', {tag: '!gone'}), /no region tagged "gone"/)
  assert.throws(() => sliceRegion('a\nb\n', {lines: 'nope'}), /unparseable/)
  assert.throws(() => sliceRegion('a\nb\n', {lines: '5..6'}), /past end of file/)
})

// Per Asciidoctor: a list is the union in file order, a bare negation is everything outside it, and they combine.
test('tag lists are a union in file order, negation is an exclusion, and they nest', () => {
  const src = [
    'intro',
    '//tag::a[]', 'A', '//end::a[]',
    'middle',
    '//tag::b[]', 'B', '//end::b[]',
    'tail',
  ].join('\n') + '\n'

  assert.equal(sliceRegion(src, {tag: 'a;b'}), 'A\nB\n')
  assert.equal(sliceRegion(src, {tag: 'b;a'}), 'A\nB\n', 'file order wins over list order')
  assert.equal(sliceRegion(src, {tag: 'a,b'}), 'A\nB\n', 'a comma separates as a semicolon does')
  assert.equal(sliceRegion(src, {tag: '!a'}), 'intro\nmiddle\nB\ntail\n')
  assert.equal(sliceRegion(src, {tag: '!a;!b'}), 'intro\nmiddle\ntail\n')
  assert.equal(sliceRegion(src, {tag: 'a;!a'}), '')

  const nested = [
    '//tag::outer[]', 'O1',
    '//tag::inner[]', 'I', '//end::inner[]',
    'O2', '//end::outer[]',
  ].join('\n') + '\n'
  assert.equal(sliceRegion(nested, {tag: 'outer;!inner'}), 'O1\nO2\n', 'excluding a nested region keeps the rest of its parent')
})

test('tag names match exactly, not by prefix', () => {
  const src = '//tag::ab[]\nAB\n//end::ab[]\n//tag::a[]\nA\n//end::a[]\n'
  assert.equal(sliceRegion(src, {tag: 'a'}), 'A\n')
  assert.equal(sliceRegion(src, {tag: 'ab'}), 'AB\n')
})

test('a leading UTF-8 BOM is dropped, as Asciidoctor drops it', () => {
  assert.equal(stripBom('﻿x'), 'x')
  assert.equal(sliceRegion('﻿//tag::t[]\nx\n//end::t[]\n', {tag: 't'}), 'x\n')
  assert.equal(sliceRegion('﻿a\n', null), 'a\n')
})

// The query allRegions reports is pasted into an `import … from` path, where webpack reads `!` as the
// inline-loader separator. Every such character must be percent-encoded and decode back to the exact spec.
test('allRegions queries are safe as webpack requests and decode back to the exact selector', () => {
  const src = [
    'intro',
    '//tag::a[]', 'A', '//end::a[]',
    'middle',
    '//tag::b[]', 'B', '//end::b[]',
    'tail',
  ].join('\n') + '\n'

  const queries = allRegions(src, ['!a', 'a;b']).map((r) => r.query).filter(Boolean)
  assert.ok(queries.length)
  for (const q of queries) assert.ok(!q.includes('!'), `${q} carries a bare !`)
  const decoded = queries.map((q) => new URLSearchParams(q).get('tags')).filter(Boolean)
  assert.ok(decoded.includes('!a'))
  assert.ok(decoded.includes('a;b'))
})

// The converter emits the query allRegions reports and the loader re-derives the content from it: they must agree.
test('every allRegions query replays through sliceRegion to the same content', () => {
  const src = 'import x;\n//tag::t[]\n    a();\n//end::t[]\n'
  const regions = allRegions(src)
  const byQuery = new Map(regions.map((r) => [r.query, r.content]))

  assert.equal(byQuery.get(''), src, 'the unqueried entry is the raw file')
  assert.ok(byQuery.has('?tag=t') && byQuery.has('?tag=t&indent=0'), 'each tag is offered as authored and reindented')

  for (const r of regions) {
    if (r.query === '') continue
    const q = new URLSearchParams(r.query.slice(1))
    const sel = {}
    if (q.get('tag')) sel.tag = q.get('tag')
    if (q.get('indent') != null) sel.indent = q.get('indent')
    assert.equal(sliceRegion(src, sel), r.content, r.query)
  }
})
