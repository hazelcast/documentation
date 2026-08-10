'use strict'

// Unit self-test for the construct-coverage gate's detectors -- the pure logic
// that decides WHICH construct a line/block is. If a detector misfires the gate
// passes green while a real construct slips through unclassified, so this guards
// the matchers directly, without needing a source mirror or a converted tree.
// (gitShow is I/O and is not exercised here.) Run:
//   node constructcheck/selftest.js

const assert = require('node:assert')

const { detectLexical, detectAst } = require('./lib/detect')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// category:token keys for a chunk of AsciiDoc, as a Set (what the gate dedupes on).
const keys = (text) => new Set(detectLexical(text).map((c) => `${c.category}:${c.token}`))
const astKeys = (text) => new Set(detectAst(text).map((c) => `${c.category}:${c.token}`))

// --- conditionals ---------------------------------------------------------
{
  const k = keys('ifdef::snapshot[]\ncontent\nendif::[]\nifndef::foo[]\nx\nendif::[]')
  assert(k.has('conditional:ifdef::snapshot'), 'ifdef carries its attribute name')
  assert(k.has('conditional:ifndef::foo'), 'ifndef carries its attribute name')
  assert(k.has('conditional:endif::'), 'endif collapses to one token')
  ok('conditionals: ifdef/ifndef keep the gated attribute, endif collapses')
}

// --- include family classification (the fiddly, high-value one) -----------
{
  assert(keys('include::partial$note.adoc[]').has('include:partial'), 'partial$ -> partial')
  assert(keys('include::example$config/hz.yaml[tag=x]').has('include:example'), 'example$ -> example')
  assert(keys('include::../shared/x.adoc[]').has('include:relative'), 'bare target -> relative')
  assert(keys('include::operator:ROOT:partial$foo.adoc[]').has('include:partial [x-comp]'),
    'component-qualified target is flagged cross-component')
  assert(keys('include::9.9@cloud:ROOT:x.adoc[]').has('include:relative [x-comp]'),
    'version/component-qualified bare target is relative + cross-component')
  ok('include: classifies partial/example/relative and flags cross-component')

  // an include:: line must NOT also register as a generic block-macro
  const k = keys('include::partial$note.adoc[]')
  assert(!k.has('block-macro:include::'), 'include is not double-counted as a block macro')
  ok('include: not mistaken for a block macro')
}

// --- block macros vs inline macros (single vs double colon) --------------
{
  assert(keys('image::diagram.png[Architecture]').has('block-macro:image::'), 'name:: at line start -> block macro')
  const inl = keys('See xref:query:foo.adoc[the query page] and image:icon.png[].')
  assert(inl.has('inline-macro:xref:'), 'name: mid-line -> inline macro')
  assert(inl.has('inline-macro:image:'), 'inline image macro detected')
  assert(!inl.has('inline-macro:query:'),
    'a coordinate segment (query: in xref:query:foo[]) is NOT a macro -- suppressed')
  ok('macros: block (::) vs inline (:), coordinate segments suppressed')

  assert(!keys('Visit https://example.com[the site] today.').has('inline-macro:https:'),
    'URL schemes are not inline macros')
  ok('macros: http/https/mailto schemes ignored')
}

// --- source languages -----------------------------------------------------
{
  assert(keys('[source,java]').has('source-language:java'), '[source,LANG]')
  assert(keys('[,python]').has('source-language:python'), 'shorthand [,LANG]')
  ok('source-language: reads [source,LANG] and [,LANG]')
}

// --- delimited blocks -----------------------------------------------------
{
  const k = keys('----\ncode\n----\n\n====\nexample\n====\n\n--\nopen\n--')
  assert(k.has('delimited-block:listing'), '---- -> listing')
  assert(k.has('delimited-block:example'), '==== -> example')
  assert(k.has('delimited-block:open'), '-- -> open')
  ok('delimited-block: maps fence delimiters to block kinds')
}

// --- bracket styles, subs, passthrough ------------------------------------
{
  assert(keys('[.text-center]').has('bracket-style:.role'), 'leading . -> role')
  assert(keys('[#my-anchor]').has('bracket-style:anchor'), 'leading # -> anchor')
  assert(keys('[%collapsible]').has('bracket-style:%collapsible'), 'leading % -> option token')
  ok('bracket-style: role / anchor / option')

  assert([...keys('[subs="attributes+"]')].some((x) => x.startsWith('subs-override:')),
    'subs= attribute registers a subs-override')
  assert(keys('Inline pass:[<b>raw</b>] here.').has('passthrough:pass:[…]'), 'pass:[] passthrough')
  ok('subs-override + passthrough detected')
}

// --- escaped / plain text is inert ----------------------------------------
{
  assert.strictEqual(keys('Just some ordinary prose with a colon: here.').size, 0,
    'plain prose yields no constructs')
  ok('plain prose registers nothing')
}

// --- AST pass (best-effort; never throws) ---------------------------------
{
  assert(Array.isArray(detectAst('')), 'empty input -> array, no throw')
  assert(Array.isArray(detectAst('| broken |=== fragment')), 'garbage fragment -> array, no throw')
  ok('detectAst: best-effort, never throws')

  assert(astKeys('A simple paragraph.').has('ast-context:paragraph'), 'paragraph context seen')
  const src = astKeys('[source,java]\n----\nint x = 1;\n----')
  assert(src.has('ast-context:listing'), 'listing context seen')
  assert(src.has('source-language:java'), 'listing language read from the AST')
  assert(astKeys('[.custom-role]\n****\nAside.\n****').has('ast-role:custom-role'), 'block role seen')
  ok('detectAst: reads block context, source language, and roles from the tree')
}

console.log(`\n[constructcheck selftest] ${n} groups passed.`)
