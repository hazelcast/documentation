'use strict'

// Unit self-test for lib/dispositions.js -- the layer that turns an orphan
// triage DECISION into an instruction the build follows. The decisions are
// recorded once and read by four callers (converter + three gates), so what
// matters here is that a decision cannot be half-applied: a page the migration
// stops publishing must be withheld by every caller, and a `redirect` must
// either produce a working pair or fail loudly. Tests state the requirement and
// check it against an independently-written expectation, never against the
// current output. Run:
//   node lib/dispositions-selftest.js

const assert = require('node:assert')

const { isUnpublished, redirectTo, unpublishedUrls, urlBase, redirectPairs, publishedPageUrls } = require('./dispositions')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

const page = (over = {}) => ({
  component: 'hazelcast', version: '5.8-snapshot', module: 'clients',
  family: 'page', relative: 'rest.adoc', url: '/hazelcast/5.8-snapshot/clients/rest', ...over,
})
const live = () => true

// --- the withholding decision -----------------------------------------------
// Two dispositions stop a page being published, for different reasons, and the
// build must treat them identically: `drop-404` because the URL may 404, and
// `redirect` because a real page at the URL would take precedence over the
// client redirect that is the whole point of the decision. The other two
// dispositions keep the page, so they must NOT withhold it.
{
  const forDisp = (disposition, extra = {}) =>
    new Map([['hazelcast:clients/rest', { disposition, ...extra }]])

  assert.strictEqual(isUnpublished(forDisp('drop-404'), page()), true,
    'drop-404 withholds the page')
  assert.strictEqual(isUnpublished(forDisp('redirect', { to: '/x' }), page()), true,
    'redirect ALSO withholds the page -- an emitted page would beat the redirect')
  for (const keep of ['keep-in-nav', 'keep-referenced']) {
    assert.strictEqual(isUnpublished(forDisp(keep), page()), false,
      `${keep} keeps the page published`)
  }
  assert.strictEqual(isUnpublished(new Map(), page()), false,
    'an untriaged page is published (the gate flags it; the build still emits it)')

  // The by-URL view the fidelity gate uses must select exactly the same pages.
  const manifest = {
    resources: [
      page(),
      page({ module: 'maintain-cluster', relative: 'rest-api.adoc', url: '/hazelcast/5.8-snapshot/maintain-cluster/rest-api' }),
      page({ module: 'sql', relative: 'interactive-sql-maps.adoc', url: '/hazelcast/5.8-snapshot/sql/interactive-sql-maps' }),
    ],
  }
  const disp = new Map([
    ['hazelcast:clients/rest', { disposition: 'redirect', to: '/maintain-cluster/rest-api' }],
    ['hazelcast:sql/interactive-sql-maps', { disposition: 'drop-404' }],
    ['hazelcast:maintain-cluster/rest-api', { disposition: 'keep-in-nav' }],
  ])
  assert.deepStrictEqual([...unpublishedUrls(disp, manifest)].sort(),
    ['/hazelcast/5.8-snapshot/clients/rest', '/hazelcast/5.8-snapshot/sql/interactive-sql-maps'],
    'unpublishedUrls selects the same pages isUnpublished does, keyed by URL')
  ok('withholding: drop-404 and redirect both stop publication; keep-* do not')
}

// --- redirectTo is not a general "to" reader ---------------------------------
// A `to` is only meaningful on a redirect. Reading it off any other disposition
// would let a stray key silently redirect a page nobody decided to redirect.
{
  assert.strictEqual(
    redirectTo(new Map([['hazelcast:clients/rest', { disposition: 'redirect', to: '/maintain-cluster/rest-api' }]]), page()),
    '/maintain-cluster/rest-api', 'a redirect yields its target')
  assert.strictEqual(
    redirectTo(new Map([['hazelcast:clients/rest', { disposition: 'drop-404', to: '/somewhere' }]]), page()),
    null, 'a stray "to" on a non-redirect is ignored, not obeyed')
  assert.strictEqual(redirectTo(new Map(), page()), null, 'an untriaged page has no target')
  ok('redirectTo reads a target only from a redirect decision')
}

// --- urlBase: subtract the tail, never count segments ------------------------
// The base is what makes one version-independent `to` resolve correctly in every
// version. Counting path segments would get ROOT-module and unversioned pages
// wrong, so the requirement is stated as: base + tail === the page's own URL.
{
  const cases = [
    [page(), '/hazelcast/5.8-snapshot'],
    [page({ version: '5.0', url: '/hazelcast/5.0/clients/rest' }), '/hazelcast/5.0'],
    [page({ module: 'ROOT', relative: 'placeholder.adoc', url: '/hazelcast/5.8-snapshot/placeholder' }), '/hazelcast/5.8-snapshot'],
    [page({ component: 'cloud', version: '', module: 'ROOT', relative: 'install.adoc', url: '/cloud/install' }), '/cloud'],
    [page({ module: 'sql', relative: 'nested/deep/page.adoc', url: '/hazelcast/5.8-snapshot/sql/nested/deep/page' }), '/hazelcast/5.8-snapshot'],
  ]
  for (const [r, expected] of cases) {
    assert.strictEqual(urlBase(r), expected, `base of ${r.url}`)
    assert.ok(r.url.startsWith(urlBase(r) + '/'), 'the base is a prefix of the page URL')
  }
  assert.strictEqual(urlBase(page({ url: '/hazelcast/5.8-snapshot/somewhere/else' })), null,
    'a URL that was not built from the coordinate yields null rather than a guess')
  ok('urlBase subtracts the module/relative tail (ROOT + unversioned + nested)')
}

// --- redirectPairs: resolve within the version, fail closed ------------------
{
  const versions = ['5.8-snapshot', '5.7']
  const manifest = {
    resources: versions.flatMap((v) => [
      page({ version: v, url: `/hazelcast/${v}/clients/rest` }),
      page({ version: v, module: 'maintain-cluster', relative: 'rest-api.adoc', url: `/hazelcast/${v}/maintain-cluster/rest-api` }),
    ]),
  }
  const disp = new Map([['hazelcast:clients/rest', { disposition: 'redirect', to: '/maintain-cluster/rest-api' }]])

  // One allowlist key, many versions: each version must redirect INTO ITSELF.
  // A pair that crossed versions would silently move readers off the version
  // they were reading.
  const pairs = redirectPairs(disp, manifest, live)
  assert.deepStrictEqual(pairs.slice().sort((a, b) => a.from.localeCompare(b.from)), [
    { from: '/hazelcast/5.7/clients/rest', to: '/hazelcast/5.7/maintain-cluster/rest-api' },
    { from: '/hazelcast/5.8-snapshot/clients/rest', to: '/hazelcast/5.8-snapshot/maintain-cluster/rest-api' },
  ], 'one key yields one within-version pair per version the page exists in')
  for (const p of pairs) {
    const ver = (u) => u.split('/')[2]
    assert.strictEqual(ver(p.from), ver(p.to), 'no pair crosses a version boundary')
  }

  // Only live versions are real routes; a frozen version is served elsewhere.
  const only58 = redirectPairs(disp, manifest, (r) => r.version === '5.8-snapshot')
  assert.deepStrictEqual(only58.map((p) => p.from), ['/hazelcast/5.8-snapshot/clients/rest'],
    'a version that is not live contributes no redirect')

  // Fail closed: a target that is not a published page is an allowlist bug, and
  // must be named rather than shipped as a redirect into a 404.
  const missing = new Map([['hazelcast:clients/rest', { disposition: 'redirect', to: '/maintain-cluster/typo' }]])
  assert.throws(() => redirectPairs(missing, manifest, live), /not a published page/,
    'a target that does not exist throws')

  const intoDropped = new Map([
    ['hazelcast:clients/rest', { disposition: 'redirect', to: '/maintain-cluster/rest-api' }],
    ['hazelcast:maintain-cluster/rest-api', { disposition: 'drop-404' }],
  ])
  assert.throws(() => redirectPairs(intoDropped, manifest, live), /not a published page/,
    'a target that is itself withheld throws -- a redirect to a 404 is not a redirect')

  // A page with no decision contributes nothing at all.
  assert.deepStrictEqual(redirectPairs(new Map(), manifest, live), [],
    'no redirect decisions => no pairs')
  ok('redirectPairs resolves within the version, gates on live, and fails closed')
}

// --- publishedPageUrls: the set every redirect target must be in ----------------
// The rule any redirect has to satisfy, whichever source it comes from. It is
// stated once here because BOTH callers depend on it: redirectPairs checks its
// own `to`, and the converter checks page-ALIAS targets against it. Missing the
// second one shipped a redirect into a dropped page and failed the site build
// (getting-started/resources is drop-404 and carried a page-alias), so the
// property is pinned rather than left to each caller to remember.
{
  const page = (over = {}) => ({
    component: 'hazelcast', version: '5.8-snapshot', module: 'getting-started',
    family: 'page', relative: 'resources.adoc',
    url: '/hazelcast/5.8-snapshot/getting-started/resources', ...over,
  })
  const manifest = {
    resources: [
      page(),
      page({ module: 'clients', relative: 'rest.adoc', url: '/hazelcast/5.8-snapshot/clients/rest' }),
      page({ module: 'maintain-cluster', relative: 'rest-api.adoc', url: '/hazelcast/5.8-snapshot/maintain-cluster/rest-api' }),
      page({ version: '5.7', url: '/hazelcast/5.7/getting-started/resources' }),
      // Aliases are a different family and are never routes in their own right.
      { component: 'hazelcast', version: '5.8-snapshot', family: 'alias', url: '/hazelcast/5.8-snapshot/overview/resources', aliasTo: '/hazelcast/5.8-snapshot/getting-started/resources' },
    ],
  }
  const disp = new Map([
    ['hazelcast:getting-started/resources', { disposition: 'drop-404' }],
    ['hazelcast:clients/rest', { disposition: 'redirect', to: '/maintain-cluster/rest-api' }],
  ])
  const live = (r) => r.version === '5.8-snapshot'

  const published = publishedPageUrls(disp, manifest, live)
  assert.ok(published.has('/hazelcast/5.8-snapshot/maintain-cluster/rest-api'),
    'a published page is a valid redirect target')
  assert.ok(!published.has('/hazelcast/5.8-snapshot/getting-started/resources'),
    'a drop-404 page is NOT a valid target, so its page-alias must not redirect to it')
  assert.ok(!published.has('/hazelcast/5.8-snapshot/clients/rest'),
    'nor is a redirected page -- chaining a redirect into a redirect')
  assert.ok(!published.has('/hazelcast/5.7/getting-started/resources'),
    'nor is a page in a version that is not live')
  assert.ok(![...published].some((u) => u.endsWith('/overview/resources')),
    'an alias is not itself a route, so it can never be a target')
  ok('publishedPageUrls: the one rule every redirect target must satisfy')
}

console.log(`\n[dispositions selftest] ${n} groups passed.`)
