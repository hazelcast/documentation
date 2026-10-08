'use strict'

// Spec for src/docsPlugins.ts: a page is a snapshot page exactly when Docusaurus treats its version as unreleased,
// the sitemap lists canonical URLs only, sidebar badges follow page frontmatter, and the committed version files
// are in the form the config reads. Docusaurus's own banner logic and the site CSS are the oracles.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {site} = require('../../test/helpers/load-ts')
const {loadDocsPlugins, loadSiteConfig, readJson} = require('../../test/helpers/docs-plugins')

const {docsPlugins, ids, versionsOf, configs} = loadDocsPlugins()
const SITE_URL = 'https://docs.hazelcast.com'

test('a URL is a snapshot URL exactly when Docusaurus shows its version as unreleased', () => {
  let unreleased = 0
  for (const id of ids) {
    for (const {versionName, seg, banner} of versionsOf(id)) {
      const expected = banner === 'unreleased'
      if (expected) unreleased++
      for (const url of [`${SITE_URL}/${id}/${seg}`, `${SITE_URL}/${id}/${seg}/some/page`]) {
        assert.equal(docsPlugins.isSnapshotUrl(url), expected, `${id} ${versionName}: ${url}`)
      }
    }
  }
  assert.ok(unreleased > 0, 'at least one component has an unreleased version')
})

test('a snapshot segment matches whole path segments only', () => {
  for (const id of ids) {
    for (const {seg, banner} of versionsOf(id)) {
      if (banner !== 'unreleased') continue
      assert.equal(docsPlugins.isSnapshotUrl(`${SITE_URL}/${id}/${seg}x/page`), false)
      assert.equal(docsPlugins.isSnapshotUrl(`${SITE_URL}/other/${seg}/page`), false)
    }
  }
})

test('unversioned components and the site root are never snapshot URLs', () => {
  for (const url of ['/', '/cloud/overview', '/tutorials', '/privacy']) {
    assert.equal(docsPlugins.isSnapshotUrl(SITE_URL + url), false, url)
  }
})

// The sitemap must list only canonical URLs. The canonical is the same URL suffix in Docusaurus's `lastVersion` when
// that page exists, and the page itself otherwise.
test('the sitemap lists each page only at its canonical URL', async () => {
  const config = loadSiteConfig()
  const [, presetOptions] = config.presets.find((p) => Array.isArray(p) && p[0] === 'classic')
  const urls = []
  const expected = []
  for (const id of ids) {
    const versions = versionsOf(id)
    const lastSeg = configs[id].versions[configs[id].lastVersion].path
    const older = versions.find((v) => v.banner === 'unmaintained')
    const snapshot = versions.find((v) => v.banner === 'unreleased')
    const add = (url, kept) => { urls.push(SITE_URL + url); if (kept) expected.push(SITE_URL + url) }
    add(`/${id}/${lastSeg}`, true)
    add(`/${id}/${lastSeg}/shared/page`, true)
    if (older) {
      add(`/${id}/${older.seg}`, false)
      add(`/${id}/${older.seg}/shared/page`, false)
      add(`/${id}/${older.seg}/only-in-older`, true)
    }
    if (snapshot) {
      add(`/${id}/${snapshot.seg}/shared/page`, false)
      add(`/${id}/${snapshot.seg}/only-in-snapshot`, false)
    }
  }
  for (const url of ['/', '/cloud/overview', '/tutorials', '/privacy']) urls.push(SITE_URL + url), expected.push(SITE_URL + url)
  assert.ok(urls.length - expected.length >= ids.length, 'every versioned component contributes a dropped page')
  const items = await presetOptions.sitemap.createSitemapItems({
    defaultCreateSitemapItems: async () => urls.map((url) => ({url})),
  })
  assert.deepEqual(items.map((item) => item.url), expected)
})

// The badge classes are only useful if the site CSS draws them.
function styledBadgeClasses () {
  const css = fs.readFileSync(path.join(site, 'src/css/custom.css'), 'utf8')
  return new Set([...css.matchAll(/\.(nav-badge-[a-z]+) > \.menu__link::after/g)].map((m) => m[1]))
}

async function sidebar (frontMatterById, items) {
  const docs = Object.entries(frontMatterById).map(([id, frontMatter]) => ({id, frontMatter}))
  return configs.hazelcast.sidebarItemsGenerator({defaultSidebarItemsGenerator: async () => items, docs})
}

test('a beta or enterprise page gets the matching sidebar badge class, and the CSS styles it', async () => {
  const styled = styledBadgeClasses()
  const [beta, enterprise, plain, experimental] = await sidebar(
    {b: {beta: true}, e: {enterprise: true}, p: {}, x: {experimental: true}},
    [{type: 'doc', id: 'b'}, {type: 'doc', id: 'e'}, {type: 'doc', id: 'p'}, {type: 'doc', id: 'x'}],
  )
  assert.equal(beta.className, 'nav-badge-beta')
  assert.equal(enterprise.className, 'nav-badge-enterprise')
  assert.equal(plain.className, undefined)
  assert.equal(experimental.className, undefined, 'experimental shows on the page only')
  for (const cls of [beta.className, enterprise.className]) assert.ok(styled.has(cls), `${cls} is styled`)
})

test('beta wins over enterprise, since the sidebar has room for one badge', async () => {
  const [both] = await sidebar({d: {beta: true, enterprise: true}}, [{type: 'doc', id: 'd'}])
  assert.equal(both.className, 'nav-badge-beta')
})

test('a category takes the badge of its landing page, nested items are tagged, and existing classes are kept', async () => {
  const [category, noLanding] = await sidebar(
    {landing: {enterprise: true}, child: {beta: true}, other: {beta: true}},
    [
      {type: 'category', label: 'C', link: {type: 'doc', id: 'landing'}, items: [{type: 'doc', id: 'child', className: 'existing'}]},
      {type: 'category', label: 'D', link: {type: 'generated-index'}, items: [{type: 'doc', id: 'other'}]},
    ],
  )
  assert.equal(category.className, 'nav-badge-enterprise')
  assert.equal(category.items[0].className, 'existing nav-badge-beta')
  assert.equal(noLanding.className, undefined)
  assert.equal(noLanding.items[0].className, 'nav-badge-beta')
})

// Version names are dotted numbers, compared numerically: 5.10 is newer than 5.9.
const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

test('each <id>_versions.json lists distinct release numbers, newest first', () => {
  for (const id of ids) {
    const releases = readJson(`${id}_versions.json`)
    assert.ok(releases.length > 0 || readJson('src/currentVersions.json')[id].defaultVersion === 'current', id)
    assert.ok(releases.every((v) => /^\d+(\.\d+)+$/.test(v)), `${id}: ${releases}`)
    assert.equal(new Set(releases).size, releases.length, `${id} has no duplicates`)
    assert.deepEqual([...releases].sort((a, b) => compareVersions(b, a)), releases, `${id} is newest first`)
  }
})

test('a component missing from src/currentVersions.json fails with a message naming it', () => {
  assert.throws(() => docsPlugins.versionedDocs('no-such-component'), /'no-such-component' has no entry in src\/currentVersions\.json/)
})
