'use strict'

// Unit self-test for lib/layout.js -- the shared source/output layout config the
// converter AND all three gates resolve through. A bug here corrupts both the
// converted output and the checker that inspects it IN THE SAME WAY, so the
// fidelity diff stays clean and never catches it: exactly the shared-code blind
// spot a unit test has to cover. Pure logic, no fs/git. Run:
//   node lib/selftest.js

const assert = require('node:assert')
const path = require('node:path')

const {
  CURRENT_SEG, currentSegFor, markedAttrsFor, isVersioned, refFor, versionsToProcess, outDirFor, urlToSlug,
} = require('./layout')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- versioned vs unversioned ---------------------------------------------
{
  assert.strictEqual(isVersioned('operator'), true, 'operator is versioned (in VERSIONS)')
  assert.strictEqual(isVersioned('clc'), true, 'clc is versioned (in VERSIONS)')
  assert.strictEqual(isVersioned('cloud'), false, 'cloud is unversioned')
  assert.strictEqual(isVersioned('nope'), false, 'unknown component is not versioned')
  ok('isVersioned: reflects VERSIONS membership')
}

// --- current-seg is per component -----------------------------------------
// A component whose main IS a distinct `-snapshot` line uses the default seg;
// one whose main declares a numbered release (clc: 5.5.1) overrides it. This is
// the pivot the whole clc mapping turns on, so it gets its own group.
{
  assert.strictEqual(currentSegFor('operator'), CURRENT_SEG,
    'operator has a real -snapshot main -> default current seg (latest-snapshot)')
  assert.strictEqual(currentSegFor('cloud'), CURRENT_SEG,
    'unversioned component falls back to the default current seg')
  assert.strictEqual(currentSegFor('clc'), '5.5.1',
    'clc has no -snapshot line: its current seg is the released 5.5.1')
  assert.notStrictEqual(currentSegFor('clc'), CURRENT_SEG,
    'clc must NOT reuse the default latest-snapshot seg (it has no such render)')
  ok('currentSegFor: default for -snapshot mains, per-component override for clc')
}

// --- branch selection per segment -----------------------------------------
{
  assert.strictEqual(refFor('cloud', null), 'main', 'unversioned component reads its fixed ref')
  assert.strictEqual(refFor('operator', CURRENT_SEG), 'main', 'current segment -> main branch')
  assert.strictEqual(refFor('operator', '5.18'), 'v/5.18', 'a release segment -> its v/ branch')
  assert.strictEqual(refFor('nope', '5.18'), null, 'unknown component -> null')
  // clc reads a v/ tag for EVERY seg, current included -- it has no main source.
  assert.strictEqual(refFor('clc', currentSegFor('clc')), 'v/5.5.1',
    'clc current seg reads its v/5.5.1 tag, NOT main')
  assert.strictEqual(refFor('clc', '5.5.0'), 'v/5.5.0', 'clc release -> its v/ branch')
  ok('refFor: current->main, release->v/<seg>, unknown->null; clc current->v/ tag')
}

// --- versions to process (use override so it does not track live config) --
{
  assert.deepStrictEqual(versionsToProcess('cloud'), [{ seg: null, kind: 'unversioned' }],
    'unversioned component: a single null-seg pass')

  const vs = versionsToProcess('operator', ['9.9', '9.8'])
  assert.deepStrictEqual(vs, [
    { seg: CURRENT_SEG, kind: 'current' },
    { seg: '9.9', kind: 'release' },
    { seg: '9.8', kind: 'release' },
  ], 'versioned: current first (main), then each release in order')
  ok('versionsToProcess: unversioned single pass; versioned = current + releases')

  // and without an override it still leads with current + only ever adds releases
  const live = versionsToProcess('operator')
  assert.deepStrictEqual(live[0], { seg: CURRENT_SEG, kind: 'current' }, 'live config still leads with current')
  assert(live.slice(1).every((v) => v.kind === 'release'), 'every later entry is a release')
  ok('versionsToProcess: live config leads with current, rest are releases')

  // clc's live plan: current is 5.5.1 (not latest-snapshot), then the 5.5.0 copy
  assert.deepStrictEqual(versionsToProcess('clc'), [
    { seg: '5.5.1', kind: 'current' },
    { seg: '5.5.0', kind: 'release' },
  ], 'clc: current 5.5.1 first, then the 5.5.0 versioned copy')
  ok('versionsToProcess: clc leads with 5.5.1 as current')
}

// --- output directory -----------------------------------------------------
{
  assert.strictEqual(outDirFor('..', 'cloud', { seg: null, kind: 'unversioned' }),
    path.join('..', 'cloud'), 'unversioned -> plugin path')
  assert.strictEqual(outDirFor('..', 'operator', { seg: CURRENT_SEG, kind: 'current' }),
    path.join('..', 'operator'), 'current -> plugin path (not a versioned copy)')
  assert.strictEqual(outDirFor('..', 'operator', { seg: '5.18', kind: 'release' }),
    path.join('..', 'operator_versioned_docs', 'version-5.18'), 'release -> versioned_docs/version-<seg>')
  assert.strictEqual(outDirFor('..', 'clc', { seg: '5.5.1', kind: 'current' }),
    path.join('..', 'clc'), 'clc current (5.5.1) -> plugin path, not a versioned copy')
  assert.strictEqual(outDirFor('..', 'clc', { seg: '5.5.0', kind: 'release' }),
    path.join('..', 'clc_versioned_docs', 'version-5.5.0'), 'clc release -> versioned_docs/version-5.5.0')
  ok('outDirFor: current/unversioned to plugin path, release to versioned_docs')
}

// --- url -> slug (URL preservation, the migration's premise) --------------
{
  assert.strictEqual(urlToSlug('/cloud/get-started', 'cloud', null), '/get-started',
    'strips the /<component> prefix')
  assert.strictEqual(urlToSlug('/operator/latest-snapshot/tutorials/deploy', 'operator', 'latest-snapshot'),
    '/tutorials/deploy', 'keeps module segments (would be dropped by a stem-only slug)')
  assert.strictEqual(urlToSlug('/cloud/manage/', 'cloud', null), '/manage',
    'drops the trailing slash (trailingSlash:false)')
  assert.strictEqual(urlToSlug('/operator/5.18/', 'operator', '5.18'), '/',
    'a version root maps to /')
  assert.strictEqual(urlToSlug('/cloud', 'cloud', null), '/',
    'the component root maps to /')
  // clc's current version is served under its numeric seg (5.5.1), so its slugs
  // strip /clc/5.5.1 just like any other versioned prefix.
  assert.strictEqual(urlToSlug('/clc/5.5.1/get-started', 'clc', '5.5.1'), '/get-started',
    'clc current: strips the /clc/5.5.1 prefix')
  assert.strictEqual(urlToSlug('/clc/5.5.1/', 'clc', '5.5.1'), '/',
    'clc current root maps to /')
  ok('urlToSlug: strips prefix, keeps module path, normalises roots and trailing slash')
}

// --- marked attributes ----------------------------------------------------
{
  assert(Array.isArray(markedAttrsFor('nope')) && markedAttrsFor('nope').length === 0,
    'a component with no marked attrs -> empty array')
  assert(markedAttrsFor('cloud').includes('hazelcast-cloud'),
    'cloud marks hazelcast-cloud (ambiguous "Cloud" value)')
  // CHANGE DETECTOR (asserts the constant, not a property): the requirement it
  // stands in for is "an attribute must be MARKED whenever its resolved value
  // also appears as literal data on a page that references it", which no unit
  // test can evaluate — it is a fact about the corpus. `npm run check:refs` is
  // the real oracle: it counts occurrences against the poisoned census render and
  // fails with `extra` (over-variableised) exactly when this list is missing an
  // attribute that needs marking. operator's page-latest-supported-hazelcast is
  // here because scaling-upgrading's compatibility matrix repeats the version as
  // table data. This line only catches an accidental deletion.
  assert(markedAttrsFor('operator').includes('page-latest-supported-hazelcast'),
    'operator marks page-latest-supported-hazelcast (value collides with compatibility-table data)')
  ok('markedAttrsFor: empty by default; marks the values that collide with page data')
}

console.log(`\n[layout selftest] ${n} groups passed.`)
