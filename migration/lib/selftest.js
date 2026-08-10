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
  CURRENT_SEG, markedAttrsFor, isVersioned, refFor, versionsToProcess, outDirFor, urlToSlug,
} = require('./layout')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- versioned vs unversioned ---------------------------------------------
{
  assert.strictEqual(isVersioned('operator'), true, 'operator is versioned (in VERSIONS)')
  assert.strictEqual(isVersioned('cloud'), false, 'cloud is unversioned')
  assert.strictEqual(isVersioned('nope'), false, 'unknown component is not versioned')
  ok('isVersioned: reflects VERSIONS membership')
}

// --- branch selection per segment -----------------------------------------
{
  assert.strictEqual(refFor('cloud', null), 'main', 'unversioned component reads its fixed ref')
  assert.strictEqual(refFor('operator', CURRENT_SEG), 'main', 'current segment -> main branch')
  assert.strictEqual(refFor('operator', '5.18'), 'v/5.18', 'a release segment -> its v/ branch')
  assert.strictEqual(refFor('nope', '5.18'), null, 'unknown component -> null')
  ok('refFor: current->main, release->v/<seg>, unknown->null')
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
}

// --- output directory -----------------------------------------------------
{
  assert.strictEqual(outDirFor('..', 'cloud', { seg: null, kind: 'unversioned' }),
    path.join('..', 'cloud'), 'unversioned -> plugin path')
  assert.strictEqual(outDirFor('..', 'operator', { seg: CURRENT_SEG, kind: 'current' }),
    path.join('..', 'operator'), 'current -> plugin path (not a versioned copy)')
  assert.strictEqual(outDirFor('..', 'operator', { seg: '5.18', kind: 'release' }),
    path.join('..', 'operator_versioned_docs', 'version-5.18'), 'release -> versioned_docs/version-<seg>')
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
  ok('urlToSlug: strips prefix, keeps module path, normalises roots and trailing slash')
}

// --- marked attributes ----------------------------------------------------
{
  assert(Array.isArray(markedAttrsFor('operator')) && markedAttrsFor('operator').length === 0,
    'a component with no marked attrs -> empty array')
  assert(markedAttrsFor('cloud').includes('hazelcast-cloud'),
    'cloud marks hazelcast-cloud (ambiguous "Cloud" value)')
  ok('markedAttrsFor: empty by default, cloud marks hazelcast-cloud')
}

console.log(`\n[layout selftest] ${n} groups passed.`)
