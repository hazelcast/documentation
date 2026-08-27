'use strict'

// Unit self-test for plugins/lib/slice-region.js -- the ONE implementation of
// Asciidoctor `include::…[tag=…]` region slicing, shared by the build-time
// tag-slice loader and the converter's example index. Because both sides share
// it, a bug here corrupts the converted output and the checker that inspects it
// IN THE SAME WAY: the content match still succeeds and the fidelity diff stays
// clean. That is the shared-code blind spot only a unit test covers.
//
// The fixtures are hand-written and the expectations readable by eye, so each
// assertion states the Asciidoctor behaviour being reproduced rather than
// echoing what the code happens to do. The corpus-wide oracle is separate and
// stronger: every live example$ include site must reproduce its golden code
// block (npm run check:refs).
//
//   node lib/slice-region-selftest.js

const assert = require('node:assert')
const { sliceRegion, allRegions, parseLineRanges } = require('../../plugins/lib/slice-region')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- tag selection ---------------------------------------------------------
{
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

  assert.strictEqual(sliceRegion(src, { tag: 'body' }),
    'public class A {\n    int x = 1;\n}\n',
    'the region is the lines BETWEEN the markers: no package/import, no marker lines, nothing after end::')
  ok('tag: selects the marked region only, markers excluded')

  // The whole point of the subsystem: the file stays compilable because the
  // parts a compiler needs sit outside the region a reader sees.
  assert(!sliceRegion(src, { tag: 'body' }).includes('package'),
    'package line is outside the region')
  assert(sliceRegion(src, null).includes('package demo;'),
    'no selector -> the whole file, package line included')
  ok('tag: package/import stay in the file and out of the slice')
}

// --- indentation and trailing whitespace are preserved ---------------------
// Asciidoctor preserves both inside a listing block. Verified against the
// golden: clients/java.html keeps a line of eight spaces mid-block. The MDX
// writer trims trailing whitespace, so the converted _partials are NOT a valid
// oracle for this -- hence the explicit guard.
{
  const src = '//tag::t[]\n        a();\n        \n        b();\n//end::t[]\n'
  assert.strictEqual(sliceRegion(src, { tag: 't' }), '        a();\n        \n        b();\n',
    'leading indent kept, and the whitespace-only line keeps its spaces')
  ok('preserves leading indentation and trailing whitespace')
}

// --- trailing blank lines and the final newline ----------------------------
// Asciidoctor trims trailing blank lines off a listing block, and
// createCodeBlockMetadata strips exactly one trailing newline -- so exactly one
// is what renders with no stray last line.
{
  assert.strictEqual(sliceRegion('//tag::t[]\na();\n\n\n//end::t[]\n', { tag: 't' }), 'a();\n',
    'trailing blank lines dropped, one newline left')
  assert.strictEqual(sliceRegion('//tag::t[]\n\n\n//end::t[]\n', { tag: 't' }), '',
    'an all-blank region is empty, not a run of newlines')
  ok('tail: trailing blanks dropped, exactly one final newline')
}

// --- directive lines are stripped wherever they appear ---------------------
{
  const src = '//tag::outer[]\na();\n//tag::inner[]\nb();\n//end::inner[]\nc();\n//end::outer[]\n'
  assert.strictEqual(sliceRegion(src, { tag: 'outer' }), 'a();\nb();\nc();\n',
    "a region never shows another region's markers")
  assert.strictEqual(sliceRegion(src, { tag: 'inner' }), 'b();\n',
    'the inner region is selectable in its own right')
  ok('directives: markers of other regions are removed from the content')
}

// --- comment syntaxes ------------------------------------------------------
// Platform marks Java with `//` and XML with `<!-- … -->`; both appear in the
// corpus (6 of the 184 include sites are XML).
{
  const xml = '<config>\n  <!-- tag::realm[] -->\n  <realm name="r"/>\n  <!-- end::realm[] -->\n</config>\n'
  assert.strictEqual(sliceRegion(xml, { tag: 'realm' }), '  <realm name="r"/>\n',
    'XML comment markers are recognised')
  assert.strictEqual(sliceRegion('# tag::t[]\nkey: v\n# end::t[]\n', { tag: 't' }), 'key: v\n',
    'hash comment markers are recognised')
  ok('markers: //, <!-- --> and # comment syntaxes all recognised')
}

// --- callouts --------------------------------------------------------------
// A callout is written as a comment so the file still compiles; Asciidoctor
// drops the comment marker and keeps <N>, which is also what the swizzled
// CodeBlock consumes. The code column must not shift.
{
  assert.strictEqual(sliceRegion('//tag::t[]\n@Bean // <1>\n    // <2>\n//end::t[]\n', { tag: 't' }),
    '@Bean <1>\n    <2>\n',
    'comment marker removed, the space before it and the leading indent kept')
  assert.strictEqual(sliceRegion('//tag::t[]\nurl = "http://x"; // not a callout\n//end::t[]\n', { tag: 't' }),
    'url = "http://x"; // not a callout\n',
    'a trailing comment that is not a callout is untouched')
  ok('callouts: comment marker stripped, <N> kept, other comments untouched')
}

// --- indent=0 --------------------------------------------------------------
// `[source,java,indent=0]` is a LISTING BLOCK attribute (three Platform blocks
// use it), so whether a slice is reindented is a property of the page, not the
// file -- which is why both forms are indexed.
{
  const src = '//tag::t[]\n        if (a) {\n            b();\n\n        }\n//end::t[]\n'
  assert.strictEqual(sliceRegion(src, { tag: 't' }), '        if (a) {\n            b();\n\n        }\n',
    'without indent=0 the authored indentation is kept verbatim')
  assert.strictEqual(sliceRegion(src, { tag: 't', indent: '0' }), 'if (a) {\n    b();\n\n}\n',
    'indent=0 removes the COMMON indent, preserving relative nesting')
  ok('indent=0: reindents to the least-indented line, blank lines unaffected')
}

// --- lines= ----------------------------------------------------------------
{
  const src = ['one', 'two', 'three', 'four', 'five'].join('\n')
  assert.strictEqual(sliceRegion(src, { lines: '2..3' }), 'two\nthree\n', 'A..B is 1-indexed and inclusive at both ends')
  assert.strictEqual(sliceRegion(src, { lines: '4' }), 'four\n', 'a bare number is a single line')
  assert.strictEqual(sliceRegion(src, { lines: '4..-1' }), 'four\nfive\n', '-1 means to end of file')
  assert.strictEqual(sliceRegion(src, { lines: '1;4' }), 'one\nfour\n', 'ranges combine in the order given')
  assert.deepStrictEqual(parseLineRanges('2..3;5'), [[2, 3], [5, 5]], 'ranges parse to inclusive pairs')
  ok('lines=: 1-indexed inclusive, single line, open end, multiple ranges')
}

// --- failure is loud -------------------------------------------------------
// A page asking for a region that no longer exists must break the build. An
// empty code block would render as plausible-looking output and ship.
{
  assert.throws(() => sliceRegion('//tag::a[]\nx\n//end::a[]\n', { tag: 'gone' }, 'F.java'),
    /F\.java: no region tagged "gone"/, 'an absent tag throws and names the file')
  assert.throws(() => sliceRegion('//tag::a[]\nx\n', { tag: 'a' }), /never closed/,
    'an unterminated region throws rather than running to EOF')
  assert.throws(() => sliceRegion('//tag::a[]\nx\n//end::a[]\n', { tag: 'a;!b' }), /not supported/,
    'tag lists and negation are refused rather than mis-sliced')
  assert.throws(() => sliceRegion('a\nb\n', { lines: 'nope' }), /unparseable/,
    'an unparseable lines= range throws')
  ok('errors: absent tag, unterminated region, tag list and bad range all throw')
}

// --- partial-name safety ---------------------------------------------------
// Marker matching must be exact: `tag::a[]` must not satisfy a request for tag
// `ab`, or a page would silently show the wrong code.
{
  const src = '//tag::ab[]\nAB\n//end::ab[]\n//tag::a[]\nA\n//end::a[]\n'
  assert.strictEqual(sliceRegion(src, { tag: 'a' }), 'A\n', 'tag a selects a, not ab')
  assert.strictEqual(sliceRegion(src, { tag: 'ab' }), 'AB\n', 'tag ab selects ab, not a')
  ok('markers: tag names match exactly, not by prefix')
}

// --- allRegions agrees with the loader -------------------------------------
// The converter matches golden blocks against allRegions and emits the query it
// reports; the loader then re-derives the content from that query. If the two
// disagree the converter emits an import whose built output differs from what it
// matched -- invisible to every downstream gate.
{
  const src = 'import x;\n//tag::t[]\n    a();\n//end::t[]\n'
  const regions = allRegions(src)
  const byQuery = new Map(regions.map((r) => [r.query, r.content]))

  assert.strictEqual(byQuery.get(''), src,
    'the unqueried entry is the RAW file -- what the loader returns when there is no query')
  assert(byQuery.has('?tag=t') && byQuery.has('?tag=t&indent=0'),
    'each tag is offered both as authored and reindented')

  for (const r of regions) {
    if (r.query === '') continue
    const q = new URLSearchParams(r.query.slice(1))
    const sel = {}
    if (q.get('tag')) sel.tag = q.get('tag')
    if (q.get('indent') != null) sel.indent = q.get('indent')
    assert.strictEqual(sliceRegion(src, sel), r.content,
      `replaying ${r.query} through sliceRegion reproduces the indexed content`)
  }
  ok('allRegions: every reported query round-trips back to the same content')
}

console.log(`\n[slice-region selftest] ${n} groups passed.`)
