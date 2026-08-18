'use strict'

// Unit self-test for the construct-coverage gate's detectors. These tests state
// what the detectors SHOULD do per the AsciiDoc / Antora grammar (the spec),
// NOT whatever the current code happens to emit -- so a bug where the code and a
// naive reading of it agree is still caught. Two independent sources of truth:
//   * the AsciiDoc block/macro/conditional grammar, enumerated by hand;
//   * the real Asciidoctor parser (detectAst), used as an oracle for "which
//     block is this?" so the lexical detector is checked against the renderer,
//     not against itself.
// (gitShow is I/O and is not exercised here.) Run: node constructcheck/selftest.js

const assert = require('node:assert')

const { detectLexical, detectAst } = require('./lib/detect')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// category:token keys for a chunk of AsciiDoc, as a Set (what the gate dedupes on).
const keys = (text) => new Set(detectLexical(text).map((c) => `${c.category}:${c.token}`))
const astKeys = (text) => new Set(detectAst(text).map((c) => `${c.category}:${c.token}`))

// --- SPEC: the AsciiDoc block delimiter grammar ------------------------------
// Each delimiter opens a specific block kind. This is the language definition,
// independent of detect.js; the `|===`/`!===` rows caught a real bug where the
// lexer's regex could not match a table delimiter (it silently emitted nothing).
{
  const DELIMS = {
    '----': 'listing', '====': 'example', '****': 'sidebar', '____': 'quote',
    '....': 'literal', '++++': 'passthrough', '////': 'comment',
    '|===': 'table', '!===': 'nested-table', '--': 'open',
  }
  for (const [delim, kind] of Object.entries(DELIMS)) {
    assert(keys(`${delim}\ncontent\n${delim}`).has(`delimited-block:${kind}`),
      `AsciiDoc: ${delim} opens a ${kind} block`)
  }
  ok('delimited blocks: every AsciiDoc delimiter (incl. |===/!=== tables) is detected')
}

// --- ORACLE: agree with the real parser on block kind ------------------------
// For blocks Asciidoctor itself parses, the lexical kind must equal the context
// the parser assigns. "Which block is this?" is grounded in the renderer.
{
  const oracle = [['----', 'listing'], ['====', 'example'], ['****', 'sidebar'], ['____', 'quote'], ['....', 'literal']]
  for (const [delim, kind] of oracle) {
    const src = `${delim}\ncontent\n${delim}`
    assert(astKeys(src).has(`ast-context:${kind}`), `Asciidoctor parses ${delim} as ${kind} (oracle)`)
    assert(keys(src).has(`delimited-block:${kind}`), `lexer agrees ${delim} is ${kind}`)
  }
  const table = '|===\n| a | b\n|==='
  assert(astKeys(table).has('ast-context:table'), 'Asciidoctor parses |=== as a table (oracle)')
  assert(keys(table).has('delimited-block:table'), 'lexer agrees |=== is a table')
  ok('delimited blocks: lexical kind matches the real Asciidoctor parse')
}

// --- SPEC: preprocessor conditionals -----------------------------------------
// `ifdef::NAME[]` / `ifndef::NAME[]` gate on attribute NAME; `endif::[]` closes.
// The detector must carry the gated NAME (so distinct conditionals stay distinct)
// and collapse endif to one token.
{
  const k = keys('ifdef::snapshot[]\nx\nendif::[]\nifndef::foo[]\ny\nendif::[]')
  assert(k.has('conditional:ifdef::snapshot'), 'ifdef carries its gating attribute')
  assert(k.has('conditional:ifndef::foo'), 'ifndef carries its gating attribute')
  assert(k.has('conditional:endif::'), 'endif collapses to one token')
  ok('conditionals: ifdef/ifndef keep the gated attribute; endif collapses')
}

// --- SPEC: Antora include target grammar -------------------------------------
// A resource include is `[version@][component:][module:]family$relative`. Family
// is the token after the last colon before `$`; a bare target (no `$`) inherits
// the including file's family and is "relative"; a coordinate carrying a colon
// or `@` before the family is cross-component.
{
  assert(keys('include::partial$note.adoc[]').has('include:partial'), 'family$ -> that family')
  assert(keys('include::example$config/hz.yaml[tag=x]').has('include:example'), 'example$ -> example')
  assert(keys('include::../shared/x.adoc[]').has('include:relative'), 'no family marker -> relative')
  assert(keys('include::operator:ROOT:partial$foo.adoc[]').has('include:partial [x-comp]'),
    'component-qualified coordinate -> cross-component')
  assert(keys('include::9.9@cloud:ROOT:x.adoc[]').has('include:relative [x-comp]'),
    'version/component-qualified bare target -> relative + cross-component')
  // An include directive is not ALSO a generic block macro (the grammar reserves it).
  assert(!keys('include::partial$note.adoc[]').has('block-macro:include::'), 'include is not double-counted as a macro')
  ok('includes: classified by the Antora coordinate grammar, not double-counted')
}

// --- SPEC: macro syntax ------------------------------------------------------
// Block macro is `name::target[attrs]` at line start (double colon); inline macro
// is `name:target[attrs]` (single colon). A URL scheme (http/https/mailto/…) is
// NOT a macro. In `xref:query:foo[]`, `query:` is a coordinate segment of the
// target, not a second macro.
{
  assert(keys('image::diagram.png[Architecture]').has('block-macro:image::'), 'name:: at line start -> block macro')
  const inl = keys('See xref:query:foo.adoc[the query page] and image:icon.png[].')
  assert(inl.has('inline-macro:xref:'), 'name: mid-line -> inline macro')
  assert(inl.has('inline-macro:image:'), 'inline image macro')
  assert(!inl.has('inline-macro:query:'), 'a coordinate segment is not an independent macro')
  assert(!keys('Visit https://example.com[the site] today.').has('inline-macro:https:'),
    'a URL scheme is not a macro')
  // A VERSION-PINNED coordinate (`{attr}@component:module:page.adoc`) puts the
  // component name after `@`, not after `:`, so the lookbehind has to reject `@`
  // too. Real case: management-center getting-started/overview:137 reported a
  // non-existent `hazelcast:` macro. Asserted for both directives that take a
  // coordinate, since either can carry the pin.
  const pinned = keys('include::{page-latest-supported-hazelcast}@hazelcast:deploy:versioning-compatibility.adoc[tag=supported-jvms]')
  assert(!pinned.has('inline-macro:hazelcast:'),
    'the component of a version-pinned coordinate is not a macro')
  assert(!pinned.has('inline-macro:deploy:'), 'nor is its module')
  assert(pinned.has('include:relative [x-comp]'), 'and the include itself is still classified')
  const pinnedXref = keys('See xref:5.7@hazelcast:sql:create-index.adoc[CREATE INDEX] for details.')
  assert(pinnedXref.has('inline-macro:xref:'), 'a version-pinned xref is still an xref macro')
  assert(!pinnedXref.has('inline-macro:hazelcast:'), 'but its component is not a second macro')
  ok('macros: block :: vs inline :, URL schemes and coordinate segments excluded')
}

// --- SPEC: source block language ---------------------------------------------
// `[source,LANG]` and the shorthand `[,LANG]` declare a highlighted language.
{
  assert(keys('[source,java]').has('source-language:java'), '[source,LANG]')
  assert(keys('[,python]').has('source-language:python'), 'shorthand [,LANG]')
  // Oracle: the real parser attaches the same language attribute to a listing.
  assert(astKeys('[source,java]\n----\nint x = 1;\n----').has('source-language:java'),
    'Asciidoctor attaches the language to the listing (oracle)')
  ok('source-language: [source,LANG] / [,LANG], matching the real parse')
}

// --- SPEC: prose is not a construct ------------------------------------------
{
  assert.strictEqual(keys('Just ordinary prose with a colon: here.').size, 0, 'plain prose yields nothing')
  ok('plain prose registers no construct')
}

// --- ROBUSTNESS: AST pass is best-effort, never throws -----------------------
{
  assert(Array.isArray(detectAst('')), 'empty input -> array, no throw')
  assert(Array.isArray(detectAst('| broken |=== fragment')), 'garbage fragment -> array, no throw')
  assert(astKeys('A simple paragraph.').has('ast-context:paragraph'), 'reads block context from the tree')
  assert(astKeys('[.custom-role]\n****\nAside.\n****').has('ast-role:custom-role'), 'reads block roles from the tree')
  ok('detectAst: best-effort (never throws) and reads context/roles from the tree')
}

console.log(`\n[constructcheck selftest] ${n} groups passed.`)
