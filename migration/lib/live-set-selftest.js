'use strict'

// Unit self-test for lib/live-set.js -- the set of pages cutover must publish,
// which `--strict` holds the gates to. Its danger is a page silently left OUT of
// the set: strict mode would then pass without ever looking for it. So each case
// states, from the migration plan rather than from the code, whether a page must
// be published. Run:
//   node lib/live-set-selftest.js

const assert = require('node:assert')

const { expectedPages, renderId, MIGRATED_COMPONENTS } = require('./live-set')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

const page = (component, version, relative, url, over = {}) =>
  ({ component, version, module: 'ROOT', family: 'page', relative, url, ...over })

const manifest = {
  resources: [
    page('cloud', '', 'overview.adoc', '/cloud/overview'),
    page('operator', 'latest-snapshot', 'index.adoc', '/operator/latest-snapshot/'),
    page('operator', '5.19', 'index.adoc', '/operator/5.19/'),
    // 5.11 and older are frozen as static HTML, not migrated.
    page('operator', '5.11', 'index.adoc', '/operator/5.11/'),
    // tutorials has no nav source but IS migrated.
    page('tutorials', '', 'kafka.adoc', '/tutorials/kafka'),
    // The tutorials landing page is owned by src/pages/tutorials.tsx.
    page('tutorials', '', 'index.adoc', '/tutorials/'),
    // Components the migration does not carry.
    page('home', '', 'index.adoc', '/home/'),
    page('jdbc-driver', '5.2-snapshot', 'index.adoc', '/jdbc-driver/5.2-snapshot/'),
    // Not pages.
    page('cloud', '', 'overview.adoc', '/', { family: 'alias' }),
    page('cloud', '', 'shared.adoc', null, { family: 'partial' }),
    // An orphan decision withholds this one.
    page('cloud', '', 'old.adoc', '/cloud/old'),
  ],
}
const dispositions = new Map([['cloud:old', { disposition: 'drop-404' }]])

{
  const urls = expectedPages(manifest, dispositions).map((r) => r.url).sort()
  assert.deepStrictEqual(urls, [
    '/cloud/overview',
    '/operator/5.19/',
    '/operator/latest-snapshot/',
    '/tutorials/kafka',
  ])
  ok('live set: live versions of migrated components, minus frozen, withheld, site-owned and non-page resources')
}

{
  assert.ok(MIGRATED_COMPONENTS.includes('tutorials'), 'a navless migrated component is in the migrated set')
  ok('migrated components include navless ones')
}

{
  // The format build-snapshot.js writes to snapshot-errors.json.
  assert.strictEqual(renderId(page('cloud', '', 'overview.adoc', '/cloud/overview')), '@cloud:ROOT:overview.adoc')
  assert.strictEqual(renderId(page('operator', '5.19', 'index.adoc', '/operator/5.19/', { module: 'tutorials' })), '5.19@operator:tutorials:index.adoc')
  ok('renderId matches the snapshot error id')
}

console.log(`\nlive-set selftest: ${n} passed`)
