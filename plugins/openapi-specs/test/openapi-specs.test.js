'use strict'

// Spec: every spec an <ApiReference> page declares is fetched from the product repo at that page's version, staged at
// the URL the page will request it from, and a build never publishes a page whose spec is missing or stale.
// GitHub is replaced by a mocked fetch; the page-side URL comes from the component's own derivation.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const openapiSpecs = require('..')
const {specUrlFor} = require('../../lib/api-spec-url')
const {operationAnchor} = require('../../lib/api-anchors')

const SOURCE = 'https://github.com/hazelcast/product/blob/{api-branch}/api/rest-client-api.yaml'
const COMPONENT = 'management-center'
const CURRENT_SEG = '5.12-snapshot'

const specYaml = (title, paths = ['/rest/clusters']) => [
  'openapi: 3.0.3',
  `info: {title: ${title}, version: '1'}`,
  'paths:',
  ...paths.flatMap((p) => [`  ${p}:`, '    get:', '      responses: {200: {description: ok}}']),
  '',
].join('\n')

const tmpDirs = []
test.after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})))

function site ({pages = {}, staged = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-specs-'))
  tmpDirs.push(dir)
  for (const [rel, content] of Object.entries({...pages, ...staged})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
    fs.writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

const page = (source = SOURCE) => `# API\n\n<ApiReference source="${source}" />\n`

const TWO_VERSIONS = {
  [`${COMPONENT}/api.mdx`]: page(),
  [`${COMPONENT}_versioned_docs/version-5.11/api.mdx`]: page(),
}

const OPTIONS = {
  variables: {},
  versionedVariables: {[COMPONENT]: {current: {'api-branch': 'main'}, '5.11': {'api-branch': 'v5.11.1'}}},
  docs: [{id: COMPONENT, currentSeg: CURRENT_SEG}],
}

// Where Docusaurus serves each version, and so where the page asks for its spec.
const pageUrl = (seg) => specUrlFor(`/${COMPONENT}/${seg}`, SOURCE)

// A GitHub contents API stand-in: one spec per ref, ETags, and a log of what was asked.
function github (t, specsByRef, {status} = {}) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, {headers}) => {
    const u = new URL(url)
    const ref = u.searchParams.get('ref')
    calls.push({path: u.pathname, ref, headers})
    if (status) return new Response('nope', {status})
    const etag = `"${ref}"`
    if (headers['If-None-Match'] === etag) return new Response(null, {status: 304})
    const content = specsByRef[ref]
    if (content === undefined) return new Response('not found', {status: 404})
    return Response.json({content: Buffer.from(content).toString('base64'), sha: `sha-${ref}-0000000000`}, {headers: {etag}})
  })
  return calls
}

function env (t, vars) {
  const saved = {}
  for (const key of ['NODE_ENV', 'NETLIFY', 'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_CREDENTIALS']) {
    saved[key] = process.env[key]
    if (key in vars) process.env[key] = vars[key]
    else delete process.env[key]
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function quiet (t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
}

const load = (siteDir, options = OPTIONS) => openapiSpecs({siteDir}, options).loadContent()
const stagedAt = (siteDir, url) => path.join(siteDir, '.api-specs', url)

test('each version\'s spec is fetched at that version\'s branch and staged where its page requests it', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  const calls = github(t, {main: specYaml('Current'), 'v5.11.1': specYaml('Old')})
  const dir = site({pages: TWO_VERSIONS})

  await load(dir)

  assert.deepEqual(calls.map((c) => c.ref).sort(), ['main', 'v5.11.1'])
  assert.ok(calls.every((c) => c.path === '/repos/hazelcast/product/contents/api/rest-client-api.yaml'))
  assert.match(fs.readFileSync(stagedAt(dir, pageUrl(CURRENT_SEG)), 'utf8'), /title: Current/)
  assert.match(fs.readFileSync(stagedAt(dir, pageUrl('5.11')), 'utf8'), /title: Old/)
})

test('the page gets the anchors and bundled spec for its own URL; identical specs are embedded once', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  github(t, {main: specYaml('Same', ['/rest/maps']), 'v5.11.1': specYaml('Same', ['/rest/maps'])})
  const dir = site({pages: TWO_VERSIONS})

  const {anchorsByUrl, specs, specHashByUrl} = await load(dir)

  for (const seg of [CURRENT_SEG, '5.11']) {
    assert.ok(anchorsByUrl[pageUrl(seg)].includes(operationAnchor('get', '/rest/maps')), seg)
    assert.equal(specs[specHashByUrl[pageUrl(seg)]].info.title, 'Same')
  }
  assert.equal(Object.keys(specs).length, 1)
})

test('several pages referencing one upstream file fetch it once', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  const calls = github(t, {main: specYaml('A')})
  const dir = site({pages: {[`${COMPONENT}/a.mdx`]: page(), [`${COMPONENT}/b.mdx`]: page()}})
  await load(dir)
  assert.equal(calls.length, 1)
})

test('a build revalidates a staged spec with its ETag and keeps it when GitHub says it is unchanged', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  const calls = github(t, {main: specYaml('Fresh')})
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}})
  await load(dir)
  fs.writeFileSync(stagedAt(dir, pageUrl(CURRENT_SEG)), specYaml('Kept'))

  await load(dir)

  assert.equal(calls.length, 2)
  assert.equal(calls[1].headers['If-None-Match'], '"main"')
  assert.match(fs.readFileSync(stagedAt(dir, pageUrl(CURRENT_SEG)), 'utf8'), /title: Kept/)
})

test('the dev server does not refetch a spec that is already staged', async (t) => {
  env(t, {NODE_ENV: 'development', GITHUB_TOKEN: 't'})
  quiet(t)
  const calls = github(t, {main: specYaml('A')})
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}, staged: {[path.join('.api-specs', pageUrl(CURRENT_SEG))]: specYaml('Staged')}})
  await load(dir)
  assert.equal(calls.length, 0)
})

test('a build fails when a spec cannot be fetched, and keeps what was already staged', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  github(t, {}, {status: 500})
  const other = path.join('.api-specs', COMPONENT, '5.10', '_attachments/swagger/older.yaml')
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}, staged: {[other]: specYaml('Other')}})

  await assert.rejects(load(dir), /could not fetch 1 spec/)
  assert.ok(fs.existsSync(path.join(dir, other)), 'a failed run prunes nothing')
})

test('without a token a build warns about an unstaged spec, skips it, and makes no requests', async (t) => {
  env(t, {NODE_ENV: 'production'})
  quiet(t)
  const calls = github(t, {main: specYaml('A')})
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}})
  const content = await load(dir)
  const warning = console.warn.mock.calls.map((c) => c.arguments[0]).join('\n')
  assert.match(warning, /no GitHub token set/)
  assert.match(warning, new RegExp(`${COMPONENT}/api\\.mdx`), 'names the affected page')
  assert.doesNotMatch(warning, /github\.com|@main/, 'does not reveal the private repos')
  assert.deepEqual(content.specHashByUrl, {})
  assert.equal(calls.length, 0)
})

test('without a token a Netlify build fails on an unstaged spec', async (t) => {
  env(t, {NODE_ENV: 'production', NETLIFY: 'true'})
  quiet(t)
  github(t, {main: specYaml('A')})
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}})
  await assert.rejects(load(dir), /no GitHub token set/)
})

test('a token is read from GITHUB_TOKEN, GH_TOKEN or the user of GIT_CREDENTIALS', async (t) => {
  for (const [vars, expected] of [
    [{GITHUB_TOKEN: 'a'}, 'Bearer a'],
    [{GH_TOKEN: 'b'}, 'Bearer b'],
    [{GIT_CREDENTIALS: 'https://c:x-oauth-basic@github.com'}, 'Bearer c'],
  ]) {
    await t.test(Object.keys(vars)[0], async (t) => {
      env(t, {NODE_ENV: 'production', ...vars})
      quiet(t)
      const calls = github(t, {main: specYaml('A')})
      await load(site({pages: {[`${COMPONENT}/api.mdx`]: page()}}))
      assert.equal(calls[0].headers.Authorization, expected)
    })
  }
})

test('after a complete run, staged specs no page references any more are removed', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  github(t, {main: specYaml('A')})
  const stale = path.join('.api-specs', COMPONENT, '5.10', '_attachments/swagger/withdrawn.yaml')
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}, staged: {[stale]: specYaml('Old')}})
  await load(dir)
  assert.ok(!fs.existsSync(path.join(dir, stale)))
  assert.ok(fs.existsSync(stagedAt(dir, pageUrl(CURRENT_SEG))))
})

test('a source that is not a GitHub blob URL fails with the page named', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  github(t, {})
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page('https://example.com/spec.yaml')}})
  await assert.rejects(load(dir), /api\.mdx: <ApiReference source> must be a GitHub blob URL/)
})

// The page derives its request URL from the unresolved source, so a variable in the file name would 404 silently.
test('an attribute in the spec file name fails the build', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  github(t, {})
  const source = 'https://github.com/hazelcast/product/blob/main/api/{api-branch}.yaml'
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page(source)}})
  await assert.rejects(load(dir), /must not appear in the FILE NAME/)
})

test('a build fails when two operations in a spec would publish the same anchor', async (t) => {
  env(t, {NODE_ENV: 'production', GITHUB_TOKEN: 't'})
  quiet(t)
  github(t, {main: specYaml('Clash', ['/a-b', '/a/b'])})
  const dir = site({pages: {[`${COMPONENT}/api.mdx`]: page()}})
  await assert.rejects(load(dir), /"#get-a-b" is published by get \/a-b and get \/a\/b/)
})

test('specs.json is always written, since the renderer imports it statically', async () => {
  const written = {}
  let globalData
  const plugin = openapiSpecs({siteDir: os.tmpdir()}, {})
  await plugin.contentLoaded({
    content: undefined,
    actions: {createData: async (name, data) => { written[name] = JSON.parse(data) }, setGlobalData: (d) => { globalData = d }},
  })
  assert.deepEqual(written['specs.json'], {specs: {}, specHashByUrl: {}})
  assert.deepEqual(globalData, {anchorsByUrl: {}})
})
