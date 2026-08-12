'use strict'

// Unit self-test for the orphan gate's pure logic. Each test states what the
// function SHOULD do per an independent source of truth — the AsciiDoc xref/
// include grammar, the definition of an orphan, and the allowlist schema — not
// what the current code happens to emit, so a bug where code and a naive reading
// of it agree is still caught. The catalog I/O in run.js (resolving specs to
// page ids) is not exercised here; run.js is validated end-to-end against the
// real corpus. Run: node orphancheck/selftest.js

const assert = require('node:assert')

const {
  DISPOSITIONS, xrefTargets, includeTargets, logicalKey,
  classifyOrphans, validateAllowlist, applyAllowlist,
} = require('./lib/reachability')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- SPEC: the xref macro grammar --------------------------------------------
// `xref:TARGET[...]`; TARGET runs to the `[` with no whitespace. `<<id>>` is an
// intra-document anchor ref and must NOT be treated as a page link.
{
  assert.deepStrictEqual(xrefTargets('See xref:clients/rest.adoc[the REST page].'), ['clients/rest.adoc'],
    'plain xref target extracted')
  assert.deepStrictEqual(
    xrefTargets('xref:5.7@hazelcast:ROOT:sql/select.adoc#where[x] and xref:overview.adoc[]'),
    ['5.7@hazelcast:ROOT:sql/select.adoc#where', 'overview.adoc'],
    'fully-qualified coordinate + fragment kept intact; multiple targets')
  assert.deepStrictEqual(xrefTargets('An <<internal-anchor>> and <<other,text>>.'), [],
    '<<...>> anchor refs are not page links')
  assert.deepStrictEqual(xrefTargets('no links here at all'), [], 'prose yields nothing')
  ok('xref extraction follows the macro grammar; excludes <<anchors>>')
}

// --- SPEC: the include directive grammar -------------------------------------
// `include::TARGET[attrs]` at line start (leading whitespace tolerated); the
// attribute list is dropped. Not the same as an xref.
{
  assert.deepStrictEqual(includeTargets('include::partial$note.adoc[]'), ['partial$note.adoc'],
    'block include target extracted, attrs dropped')
  assert.deepStrictEqual(includeTargets('   include::example$hz.yaml[tag=x]'), ['example$hz.yaml'],
    'leading whitespace tolerated')
  assert.deepStrictEqual(includeTargets('this mentions include::foo[] mid-sentence'), [],
    'include is a line-start block macro, not matched mid-line')
  assert.deepStrictEqual(includeTargets('xref:foo.adoc[bar]'), [], 'an xref is not an include')
  ok('include extraction is line-anchored and distinct from xref')
}

// --- SPEC: logical page key --------------------------------------------------
// Version-independent identity: {component}[:{module}]/{relative-without-.adoc};
// ROOT module elided. This is the unit the allowlist keys on.
{
  assert.strictEqual(logicalKey({ component: 'cloud', module: 'ROOT', relative: 'teams-and-users.adoc' }),
    'cloud:teams-and-users', 'ROOT module elided, .adoc dropped')
  assert.strictEqual(logicalKey({ component: 'hazelcast', module: 'ROOT', relative: 'clients/rest.adoc' }),
    'hazelcast:clients/rest', 'subdir path preserved')
  assert.strictEqual(logicalKey({ component: 'operator', module: 'tutorials', relative: 'connect.adoc' }),
    'operator:tutorials/connect', 'non-ROOT module kept as a segment')
  // Same page, different versions -> identical key (one decision spans branches).
  const a = logicalKey({ component: 'clc', module: 'ROOT', relative: 'clc-cpmap.adoc', version: '5.5.1' })
  const b = logicalKey({ component: 'clc', module: 'ROOT', relative: 'clc-cpmap.adoc', version: '5.4' })
  assert.strictEqual(a, b, 'version is not part of the logical key')
  ok('logical key is version-independent and module-aware')
}

// --- SPEC: orphan classification ---------------------------------------------
// Orphan iff neither a nav entry nor a landing page. kind=referenced iff linked.
// Independent oracle: a hand-built 4-page corpus with the reachability spelled
// out, checked against the orphan definition directly.
{
  const pages = [
    { id: 'p-nav', url: '/c/in-nav', component: 'c', version: '', module: 'ROOT', relative: 'in-nav.adoc' },
    { id: 'p-land', url: '/c/', component: 'c', version: '', module: 'ROOT', relative: 'index.adoc' },
    { id: 'p-ref', url: '/c/referenced', component: 'c', version: '', module: 'ROOT', relative: 'referenced.adoc' },
    { id: 'p-dead', url: '/c/dead', component: 'c', version: '', module: 'ROOT', relative: 'dead.adoc' },
  ]
  const navIds = new Set(['p-nav'])
  const startIds = new Set(['p-land'])
  const linkedBy = new Map([['p-ref', ['/c/in-nav']]]) // only p-ref is linked, from the nav page
  const orphans = classifyOrphans({ pages, navIds, startIds, linkedBy })
  const byId = new Map(orphans.map((o) => [o.id, o]))

  assert(!byId.has('p-nav'), 'a nav entry is not an orphan')
  assert(!byId.has('p-land'), 'a landing page is not an orphan')
  assert(byId.has('p-ref') && byId.has('p-dead'), 'the two non-nav non-landing pages are orphans')
  assert.strictEqual(byId.get('p-ref').kind, 'referenced', 'linked orphan -> referenced')
  assert.deepStrictEqual(byId.get('p-ref').refs, ['/c/in-nav'], 'referenced orphan carries its referrers')
  assert.strictEqual(byId.get('p-dead').kind, 'unreachable', 'unlinked orphan -> unreachable')
  ok('orphan = not(nav or landing); referenced iff something links to it')
}

// --- SPEC: allowlist schema validation ---------------------------------------
// Deny-by-default is only meaningful if the recorded decision is well-formed:
// a valid disposition, and a redirect that actually names a destination.
{
  assert.deepStrictEqual(validateAllowlist({}), [], 'empty allowlist is valid')
  assert.deepStrictEqual(
    validateAllowlist({ 'cloud:teams-and-users': { disposition: 'drop-404', note: 'internal only' } }), [],
    'a drop-404 entry with a note is valid')
  assert.deepStrictEqual(
    validateAllowlist({ 'cloud:x': { disposition: 'redirect', to: '/cloud/get-started' } }), [],
    'a redirect with a `to` is valid')

  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'redirect' } }).length, 1,
    'redirect without `to` is rejected')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'delete-it' } }).length, 1,
    'unknown disposition is rejected')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'drop-404', to: '/y' } }).length, 1,
    '`to` on a non-redirect is rejected (decision would be ambiguous)')
  assert.strictEqual(validateAllowlist({ 'c:x': 'keep' }).length, 1, 'a non-object entry is rejected')
  // The vocabulary is exactly the four documented dispositions.
  assert.deepStrictEqual([...DISPOSITIONS].sort(), ['drop-404', 'keep-in-nav', 'keep-referenced', 'redirect'],
    'disposition vocabulary is the four documented values')
  ok('allowlist validation enforces disposition vocabulary + redirect target')
}

// --- SPEC: deny-by-default application ----------------------------------------
// Only an allowlisted logical key is cleared; everything else is flagged. An
// allow key matching no orphan is stale (surfaced, not fatal). One key clears
// every version of that page.
{
  const orphans = classifyOrphans({
    pages: [
      { id: 'i1', url: '/c/a', component: 'c', version: '5.7', module: 'ROOT', relative: 'a.adoc' },
      { id: 'i2', url: '/c/a-old', component: 'c', version: '5.6', module: 'ROOT', relative: 'a.adoc' },
      { id: 'i3', url: '/c/b', component: 'c', version: '5.7', module: 'ROOT', relative: 'b.adoc' },
    ],
    navIds: new Set(), startIds: new Set(), linkedBy: new Map(),
  })
  const { flagged, allowed, staleKeys } = applyAllowlist(orphans, {
    'c:a': { disposition: 'drop-404' },
    'c:ghost': { disposition: 'keep-in-nav' },
  })
  assert.deepStrictEqual(allowed.map((o) => o.id).sort(), ['i1', 'i2'],
    'one logical key clears the page across both its versions')
  assert.deepStrictEqual(flagged.map((o) => o.id), ['i3'], 'the un-listed page stays flagged')
  assert.deepStrictEqual(staleKeys, ['c:ghost'], 'an allow key matching no orphan is reported stale')
  ok('deny-by-default: only listed keys clear (all versions); stale keys surfaced')
}

console.log(`\n[orphancheck selftest] ${n} groups passed.`)
