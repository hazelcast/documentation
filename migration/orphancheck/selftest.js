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
  DISPOSITIONS, xrefTargets, includeTargets, logicalKey, scopeToMigrated,
  classifyOrphans, validateAllowlist, applyAllowlist, crossCheckUnlisted,
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

// --- SPEC: migrated-version scoping -------------------------------------------
// Only pages this site publishes may be judged: a migrated component at a live
// version. Oracle is the rule itself, stated over a corpus mixing live versions,
// frozen versions and an unmigrated component — the real clc shape, where a page
// orphaned only in a frozen branch keeps being served by the frozen origin.
{
  const pages = [
    { id: 'live-cur', component: 'clc', version: '5.5.1', relative: 'a.adoc' },
    { id: 'live-rel', component: 'clc', version: '5.5.0', relative: 'a.adoc' },
    { id: 'frozen', component: 'clc', version: '5.3.5', relative: 'a.adoc' },
    { id: 'frozen-old', component: 'clc', version: '5.2.1', relative: 'a.adoc' },
    { id: 'unversioned', component: 'cloud', version: '', relative: 'b.adoc' },
    { id: 'unmigrated', component: 'hazelcast', version: '5.7', relative: 'c.adoc' },
  ]
  const migrated = new Map([
    ['clc', new Set(['5.5.1', '5.5.0'])],
    ['cloud', new Set([''])],
  ])
  const kept = scopeToMigrated(pages, migrated).map((p) => p.id)

  assert.deepStrictEqual(kept, ['live-cur', 'live-rel', 'unversioned'],
    'only migrated components at live versions are judged')
  assert(!kept.includes('frozen') && !kept.includes('frozen-old'),
    'a page in a frozen branch is served by the frozen origin, not triaged here')
  assert(!kept.includes('unmigrated'),
    'a component with no live versions falls out entirely until it migrates')
  // The unversioned entry is version '' — it must not be confused with "no live set".
  assert.deepStrictEqual(scopeToMigrated([{ id: 'u', component: 'cloud', version: '' }],
    new Map([['cloud', new Set([''])]])).map((p) => p.id), ['u'],
  'empty-string version is a real version, not a missing one')
  assert.deepStrictEqual(scopeToMigrated(pages, new Map()), [],
    'no migrated components => nothing to judge')
  ok('scope = migrated components x live versions; frozen + unmigrated excluded')
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

  assert.deepStrictEqual(
    validateAllowlist({ 'hazelcast:clients/clc': { disposition: 'redirect', toUrl: '/clc/5.5.1/overview' } }), [],
    'a redirect with an absolute cross-component `toUrl` is valid')

  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'redirect' } }).length, 1,
    'redirect with neither `to` nor `toUrl` is rejected')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'delete-it' } }).length, 1,
    'unknown disposition is rejected')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'drop-404', to: '/y' } }).length, 1,
    '`to` on a non-redirect is rejected (decision would be ambiguous)')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'drop-404', toUrl: '/y/z' } }).length, 1,
    '`toUrl` on a non-redirect is rejected, for the same reason as `to`')
  assert.strictEqual(validateAllowlist({ 'c:x': 'keep' }).length, 1, 'a non-object entry is rejected')
  // `versions` narrows an entry to the versions named. A well-formed list is
  // valid; an EMPTY one is not -- it would silently disable the entry, which
  // reads as "triaged" while clearing nothing.
  assert.deepStrictEqual(
    validateAllowlist({ 'c:x': { disposition: 'drop-404', versions: ['5.5', '5.4'] } }), [],
    'a non-empty list of version segments is valid')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'drop-404', versions: [] } }).length, 1,
    'an empty "versions" is rejected rather than read as "nowhere"')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'drop-404', versions: '5.5' } }).length, 1,
    '"versions" must be an array, not a bare string')
  assert.strictEqual(validateAllowlist({ 'c:x': { disposition: 'drop-404', versions: ['5.5', ''] } }).length, 1,
    'an empty version segment is rejected')

  // The two destination forms are ALTERNATIVES, not a pair. Accepting both would
  // leave which one wins to implementation order, and they resolve differently
  // (one against the page's own version base, one not), so the recorded decision
  // would not be a decision at all.
  assert.strictEqual(
    validateAllowlist({ 'c:x': { disposition: 'redirect', to: '/a', toUrl: '/b/c' } }).length, 1,
    'giving both `to` and `toUrl` is rejected')
  // `toUrl` is absolute BY DEFINITION -- it is the form used precisely when there
  // is no base to resolve against, so a relative-looking value is a mistake that
  // would otherwise ship as a route missing its leading segment.
  assert.strictEqual(
    validateAllowlist({ 'c:x': { disposition: 'redirect', toUrl: 'clc/5.5.1/overview' } }).length, 1,
    '`toUrl` without a leading slash is rejected')
  assert.strictEqual(
    validateAllowlist({ 'c:x': { disposition: 'redirect', to: '' } }).length, 1,
    'an empty destination is rejected, not treated as absent')
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

  // SPEC: staleness is only judgeable where the run could have MATCHED. Under
  // `--component c`, another component's entry is unmatchable by construction, so
  // calling it stale is a false "prune me" -- and a warning that is permanently
  // wrong is how a reader learns to skim past the real ones.
  const other = { 'c:a': { disposition: 'drop-404' }, 'd:elsewhere': { disposition: 'drop-404' } }
  assert.deepStrictEqual(applyAllowlist(orphans, other).staleKeys, ['d:elsewhere'],
    'unscoped: another component\'s unmatched entry IS stale')
  assert.deepStrictEqual(applyAllowlist(orphans, other, 'c').staleKeys, [],
    'scoped to c: d\'s entry is out of scope, not stale')
  assert.deepStrictEqual(applyAllowlist(orphans, { ...other, 'c:ghost': { disposition: 'drop-404' } }, 'c').staleKeys,
    ['c:ghost'], 'scoping does not hide a stale entry that IS in scope')
  // Scoping is by component, not by prefix: a component whose name merely starts
  // with the scoped one must not be swept in.
  assert.deepStrictEqual(
    applyAllowlist(orphans, { 'cloudy:x': { disposition: 'drop-404' } }, 'c').staleKeys, [],
    'a same-prefix component name is not treated as the scoped component')
  ok('stale keys are judged only within the run\'s scope')
}

// --- SPEC: `versions` makes deny-by-default work PER VERSION -------------------
// A narrowed entry clears the page only in the versions it names. The property
// that matters is that narrowing can only ever SURFACE work: the same page
// orphaned in a version the entry omits must be flagged as untriaged, never
// quietly cleared. Platform 5.4/5.3 are why -- they nav via per-module partials
// and still list pages the flat 5.5+ nav dropped.
{
  const pages = [
    { id: 'i57', url: '/c/5.7/a', component: 'c', version: '5.7', module: 'ROOT', relative: 'a.adoc' },
    { id: 'i55', url: '/c/5.5/a', component: 'c', version: '5.5', module: 'ROOT', relative: 'a.adoc' },
    { id: 'i54', url: '/c/5.4/a', component: 'c', version: '5.4', module: 'ROOT', relative: 'a.adoc' },
  ]
  const orphans = classifyOrphans({ pages, navIds: new Set(), startIds: new Set(), linkedBy: new Map() })
  const scoped = { 'c:a': { disposition: 'drop-404', versions: ['5.7', '5.5'] } }
  const { flagged, allowed } = applyAllowlist(orphans, scoped, 'c', pages)
  assert.deepStrictEqual(allowed.map((o) => o.version).sort(), ['5.5', '5.7'],
    'a narrowed entry clears only the versions it names')
  assert.deepStrictEqual(flagged.map((o) => o.version), ['5.4'],
    'and the same page orphaned in an omitted version is FLAGGED, not cleared')
  // An unnarrowed entry must keep covering every version.
  assert.deepStrictEqual(
    applyAllowlist(orphans, { 'c:a': { disposition: 'drop-404' } }, 'c', pages).flagged, [],
    'an entry with no "versions" still clears every version')

  // SPEC: a `versions` list is hand-maintained, so it drifts. A version named
  // there that the page is in scope in and NOT an orphan in is reported, because
  // nothing else can catch it -- the entry still matches elsewhere, so it is not
  // a stale KEY, and the decision quietly applies to nothing in that version.
  // Here 5.4 is in nav (hence not an orphan) but still named by the entry.
  const navved = classifyOrphans({
    pages, navIds: new Set(['i54']), startIds: new Set(), linkedBy: new Map(),
  })
  const drifted = applyAllowlist(navved, { 'c:a': { disposition: 'drop-404', versions: ['5.7', '5.5', '5.4'] } }, 'c', pages)
  assert.deepStrictEqual(drifted.staleScopes, [{ key: 'c:a', versions: ['5.4'] }],
    'a named version the page is no longer an orphan in is surfaced')
  assert.deepStrictEqual(drifted.staleKeys, [],
    'and it is NOT reported as a stale key -- the entry is still doing work')
  // A version the page does not exist in at all is not judgeable, so it is not
  // reported: the page may simply be out of this run\'s scope (a frozen branch).
  assert.deepStrictEqual(
    applyAllowlist(navved, { 'c:a': { disposition: 'drop-404', versions: ['5.7', '5.5', '5.2'] } }, 'c', pages).staleScopes,
    [], 'a version outside the run\'s scope is not judged')
  // Without the full page set there is nothing to judge against, so no claim is made.
  assert.deepStrictEqual(
    applyAllowlist(navved, { 'c:a': { disposition: 'drop-404', versions: ['5.4'] } }, 'c').staleScopes,
    [], 'scope staleness is only claimed when the in-scope page set is supplied')
  ok('versions: deny-by-default per version, and a drifted narrowing is surfaced')
}

// --- SPEC: the converter's sidebar must agree with the nav -------------------
// A page Antora puts in a nav must not be emitted unlisted; a page in no nav is
// the orphan gate's business, not this check's; a landing page in no nav is
// reported separately because nothing can allowlist it.
{
  const pg = (id) => ({ id, component: 'c', version: '5.3', url: `/c/5.3/${id}` })
  const pages = [pg('listed'), pg('lost'), pg('orphan'), pg('start'), pg('fine')]
  const slugOf = (p) => `c|5.3|/${p.id}`
  const r = crossCheckUnlisted({
    pages,
    navIds: new Set(['listed', 'lost', 'fine']),
    startIds: new Set(['start']),
    emittedUnlisted: new Set(['c|5.3|/lost', 'c|5.3|/orphan', 'c|5.3|/start']),
    slugOf,
  })
  assert.deepStrictEqual(r.inNav.map((p) => p.id), ['lost'], 'in nav + emitted unlisted is the only failure')
  assert.deepStrictEqual(r.startPages.map((p) => p.id), ['start'], 'an unlisted landing page is reported apart')
  // The same slug in another version is a different page.
  assert.deepStrictEqual(crossCheckUnlisted({
    pages: [{ ...pg('lost'), version: '5.4' }], navIds: new Set(['lost']), startIds: new Set(),
    emittedUnlisted: new Set(['c|5.3|/lost']), slugOf: (p) => `c|${p.version}|/${p.id}`,
  }).inNav, [], 'matching is per version')
  ok('crossCheckUnlisted: nav-listed pages emitted unlisted fail; orphans and landing pages do not')
}

console.log(`\n[orphancheck selftest] ${n} groups passed.`)
