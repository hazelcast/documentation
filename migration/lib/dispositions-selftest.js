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

const { isUnpublished, redirectDest, redirectRoute, unpublishedUrls, urlBase, redirectPairs, publishedPageUrls, navInjectionsFor } = require('./dispositions')

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

// --- the destination is read ONLY from a redirect ----------------------------
// A `to`/`toUrl` is only meaningful on a redirect. Reading it off any other
// disposition would let a stray key silently redirect a page nobody decided to
// redirect. (The schema rejects such a key -- validateAllowlist, orphancheck --
// but these readers must not obey one either way: two independent guards, because
// this one runs against a file a human edits.)
const KEY = 'hazelcast:clients/rest'
{
  assert.strictEqual(
    redirectRoute(new Map([[KEY, { disposition: 'drop-404', to: '/somewhere' }]]), page()),
    null, 'a stray "to" on a non-redirect is ignored, not obeyed')
  assert.strictEqual(
    redirectRoute(new Map([[KEY, { disposition: 'drop-404', toUrl: '/clc/5.5.1/overview' }]]), page()),
    null, 'a stray "toUrl" on a non-redirect is likewise ignored')
  assert.strictEqual(redirectRoute(new Map(), page()), null, 'an untriaged page has no destination')
  assert.strictEqual(redirectDest(new Map(), page()), null, 'and no destination record')
  ok('a redirect destination is read only from a redirect decision')
}

// --- the two destination forms resolve differently, on purpose ---------------
// This is the whole reason they are separate fields. `to` is relative to the
// page's OWN component/version base, so one allowlist key redirects each version
// within itself. `toUrl` is absolute and is used verbatim: it names a version in
// ANOTHER component's line, where this page's base is not just unhelpful but
// wrong. Deriving the expected value here from the page URL rather than
// hardcoding it keeps this a spec check and not a transcription of the code.
{
  const p = page()
  const relDisp = new Map([[KEY, { disposition: 'redirect', to: '/maintain-cluster/rest-api' }]])
  assert.strictEqual(redirectRoute(relDisp, p), urlBase(p) + '/maintain-cluster/rest-api',
    'a `to` is resolved against the page\'s own component/version base')
  assert.strictEqual(redirectDest(relDisp, p).relative, true, 'and reports itself as relative')

  const absDisp = new Map([[KEY, { disposition: 'redirect', toUrl: '/clc/5.5.1/overview' }]])
  assert.strictEqual(redirectRoute(absDisp, p), '/clc/5.5.1/overview',
    'a `toUrl` is used verbatim -- the page\'s base is never prepended')
  assert.strictEqual(redirectDest(absDisp, p).relative, false, 'and reports itself as absolute')

  // The distinction has to survive the page moving version, which is exactly
  // what a versioned corpus does to it: the relative form follows the page, the
  // absolute form does not budge.
  const at57 = page({ version: '5.7', url: '/hazelcast/5.7/clients/rest' })
  assert.strictEqual(redirectRoute(relDisp, at57), '/hazelcast/5.7/maintain-cluster/rest-api',
    'the relative form tracks the page\'s version')
  assert.strictEqual(redirectRoute(absDisp, at57), '/clc/5.5.1/overview',
    'the absolute form is version-independent, as a cross-component pin must be')

  // A trailing slash on either form normalises away (trailingSlash: false), so a
  // destination cannot become a route that differs from the page it names.
  assert.strictEqual(
    redirectRoute(new Map([[KEY, { disposition: 'redirect', toUrl: '/clc/5.5.1/overview/' }]]), p),
    '/clc/5.5.1/overview', 'a trailing slash on `toUrl` is normalised off')

  // Only the relative form needs a base, so only it can fail for want of one.
  const noBase = page({ url: '/hazelcast/5.8-snapshot/somewhere/else' })
  assert.throws(() => redirectRoute(relDisp, noBase), /cannot derive/,
    'a relative destination on a page with no derivable base throws rather than guessing')
  assert.strictEqual(redirectRoute(absDisp, noBase), '/clc/5.5.1/overview',
    'an absolute destination needs no base, so it still resolves')
  ok('`to` resolves per version; `toUrl` is absolute and version-independent')
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

  // A cross-component `toUrl` is held to the SAME published-target rule -- it is
  // the form most able to rot (it pins a version in another component's line, and
  // nothing in this component's corpus moves when that line does), so exempting
  // it would put the check where it is least needed and drop it where it is most.
  const clcPage = {
    component: 'clc', version: '5.5.1', module: 'ROOT', family: 'page',
    relative: 'overview.adoc', url: '/clc/5.5.1/overview',
  }
  const withClc = { resources: [...manifest.resources, clcPage] }
  const crossOk = new Map([['hazelcast:clients/rest', { disposition: 'redirect', toUrl: '/clc/5.5.1/overview' }]])
  assert.deepStrictEqual(
    redirectPairs(crossOk, withClc, live).map((p) => p.to),
    ['/clc/5.5.1/overview', '/clc/5.5.1/overview'],
    'every version of the source page redirects to the one pinned cross-component route')

  const crossStale = new Map([['hazelcast:clients/rest', { disposition: 'redirect', toUrl: '/clc/9.9.9/overview' }]])
  assert.throws(() => redirectPairs(crossStale, withClc, live), /not a published page/,
    'a `toUrl` naming a version that is not published throws -- the pin has gone stale')
  // Same target, but its component/version is no longer live: the pin is fine and
  // the page still exists, yet it is not a ROUTE, so it must still fail closed.
  assert.throws(() => redirectPairs(crossOk, withClc, (r) => r.component === 'hazelcast'), /not a published page/,
    'a `toUrl` into a component that is not live throws')

  // The error has to say WHICH field to go fix, since the two are edited
  // differently and only one of them is resolved against anything.
  assert.throws(() => redirectPairs(crossStale, withClc, live), /toUrl/,
    'the message names `toUrl` when that is the field at fault')
  assert.throws(() => redirectPairs(missing, manifest, live), /"to"/,
    'and names `to` when that is')
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

// --- `versions` narrows a decision to the versions it names ------------------
// A key covers every version by default, which is right whenever a page is an
// orphan wherever it exists. Platform 5.4/5.3 are the case where it is not: they
// build nav.adoc from per-module partials and still list pages the flat 5.5+ nav
// dropped, so a decision applied across the board would withhold a page its own
// version's sidebar links to -- and for cluster-performance/performance-tuning
// would redirect 5.3 to a page that does not exist there.
//
// The requirement is symmetric and stated from both sides: inside the named
// versions the decision applies in full, outside them it does not apply AT ALL --
// not to withholding, not to the destination, not to a nav injection.
{
  const scoped = new Map([['hazelcast:clients/rest', {
    disposition: 'redirect', to: '/maintain-cluster/rest-api', versions: ['5.8-snapshot', '5.4'],
  }]])
  for (const v of ['5.8-snapshot', '5.4']) {
    assert.strictEqual(isUnpublished(scoped, page({ version: v })), true,
      `the decision applies in a version it names (${v})`)
    assert.ok(redirectDest(scoped, page({ version: v })), 'and its destination is readable there')
  }
  for (const v of ['5.7', '5.3']) {
    assert.strictEqual(isUnpublished(scoped, page({ version: v })), false,
      `the decision does not withhold the page in a version it omits (${v})`)
    assert.strictEqual(redirectDest(scoped, page({ version: v })), null,
      'and reads no destination there -- so no redirect is emitted either')
  }
  // Absent `versions` must keep the old meaning exactly: every version.
  const unscoped = new Map([['hazelcast:clients/rest', { disposition: 'drop-404' }]])
  for (const v of ['5.8-snapshot', '5.7', '5.4', '5.3']) {
    assert.strictEqual(isUnpublished(unscoped, page({ version: v })), true,
      `an entry with no "versions" still covers every version (${v})`)
  }
  // End to end through redirectPairs: the pair exists for a named version and is
  // simply absent for an omitted one, rather than resolving to a bad target. This
  // is the performance-tuning case -- at 5.3 the target page does not exist, so
  // producing a pair there is what failed the build.
  const manifest = {
    resources: [
      page({ version: '5.4', url: '/hazelcast/5.4/clients/rest' }),
      page({ version: '5.3', url: '/hazelcast/5.3/clients/rest' }),
      page({ version: '5.4', module: 'maintain-cluster', relative: 'rest-api.adoc', url: '/hazelcast/5.4/maintain-cluster/rest-api' }),
    ],
  }
  const only54 = new Map([['hazelcast:clients/rest', {
    disposition: 'redirect', to: '/maintain-cluster/rest-api', versions: ['5.4'],
  }]])
  assert.deepStrictEqual(redirectPairs(only54, manifest, live),
    [{ from: '/hazelcast/5.4/clients/rest', to: '/hazelcast/5.4/maintain-cluster/rest-api' }],
    'a scoped redirect emits a pair only for the version it names')
  // The 5.3 target genuinely does not exist in this manifest. Unscoped, that is
  // the hard failure; scoped away, there is nothing to resolve.
  const allVersions = new Map([['hazelcast:clients/rest', {
    disposition: 'redirect', to: '/maintain-cluster/rest-api',
  }]])
  assert.throws(() => redirectPairs(allVersions, manifest, live), /not a published page/,
    'and unscoped it still fails closed on the version whose target is missing')

  // A nav injection is scoped the same way, by the same field.
  const keepInNav = new Map([['hazelcast:maintain-cluster/rest-api', {
    disposition: 'keep-in-nav', nav: { after: 'maintain-cluster:rest-api-swagger' }, versions: ['5.5'],
  }]])
  assert.deepStrictEqual(navInjectionsFor(keepInNav, 'hazelcast', '5.5').map((i) => i.key),
    ['maintain-cluster:rest-api'], 'a scoped keep-in-nav injects in the version it names')
  assert.deepStrictEqual(navInjectionsFor(keepInNav, 'hazelcast', '5.4'), [],
    'and injects nothing in a version it omits')
  assert.deepStrictEqual(navInjectionsFor(keepInNav, 'hazelcast').map((i) => i.key),
    ['maintain-cluster:rest-api'], 'with no version to judge against, the entry is kept')
  ok('versions: a decision applies in the versions it names, and nowhere else')
}

console.log(`\n[dispositions selftest] ${n} groups passed.`)
