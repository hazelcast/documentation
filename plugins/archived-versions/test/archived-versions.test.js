'use strict'

// Spec: after the build, every URL under an archived version (and under /_/) is proxied with status 200 to the same
// path on the archive origin, and the rules already in _redirects still come first. The output is checked with a
// minimal Netlify rule matcher written here (first matching rule wins, `*` matches the rest of the path, which
// `:splat` repeats), not by comparing strings with the generator.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const plugin = require('..')

const MANUAL = 'https://manuals.example/mc/3.9.4/index.html'

const OPTIONS = {
  origin: 'https://archive.example',
  versions: {hazelcast: ['5.2', '5.1'], 'jdbc-driver': ['5.2-snapshot']},
  redirects: {'management-center': {'3.9': MANUAL}},
}

const tmpDirs = []
test.after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})))

async function build (existing) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-versions-'))
  tmpDirs.push(outDir)
  if (existing !== undefined) fs.writeFileSync(path.join(outDir, '_redirects'), existing)
  await plugin({}, OPTIONS).postBuild({outDir})
  return fs.readFileSync(path.join(outDir, '_redirects'), 'utf8')
}

function route (redirects, url) {
  for (const line of redirects.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [from, to, status] = line.trim().split(/\s+/)
    const match = from.endsWith('/*') ? url.startsWith(from.slice(0, -1)) && url.slice(from.length - 1) : url === from && ''
    if (match !== false) return {to: to.replace(':splat', match), status}
  }
  return null
}

test('proxies pages, images, and the UI bundle of archived versions to the same path on the origin', async () => {
  const redirects = await build('')
  for (const url of ['/hazelcast/5.2/getting-started/install', '/hazelcast/5.1/_images/arch.png', '/jdbc-driver/5.2-snapshot/install', '/_/css/site.css']) {
    assert.deepEqual(route(redirects, url), {to: `https://archive.example${url}`, status: '200'})
  }
})

test('leaves live versions and look-alike versions alone', async () => {
  const redirects = await build('')
  for (const url of ['/hazelcast/5.7/getting-started/install', '/hazelcast/5.21/x', '/hazelcast/5.2.1/x']) {
    assert.equal(route(redirects, url), null)
  }
})

test('keeps the existing rules first', async () => {
  const redirects = await build('/hazelcast/5.2/old  /hazelcast/5.2/new  301!')
  assert.deepEqual(route(redirects, '/hazelcast/5.2/old'), {to: '/hazelcast/5.2/new', status: '301!'})
  assert.equal(route(redirects, '/hazelcast/5.2/new').to, 'https://archive.example/hazelcast/5.2/new')
})

test('creates _redirects when the build has none', async () => {
  const redirects = await build(undefined)
  assert.equal(route(redirects, '/_/js/site.js').status, '200')
})

test('sends every URL of a redirected version to its external manual with a permanent redirect', async () => {
  const redirects = await build('')
  for (const url of ['/management-center/3.9', '/management-center/3.9/', '/management-center/3.9/getting-started']) {
    assert.deepEqual(route(redirects, url), {to: MANUAL, status: '301!'})
  }
  assert.equal(route(redirects, '/management-center/3.91/x'), null)
})
