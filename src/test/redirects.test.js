'use strict'

// Spec: each client redirect in src/redirects.ts is the only redirect for its old URL and can be reached. The build
// already fails on a redirect to a page that does not exist; these are the cases it only warns about or cannot see.

const test = require('node:test')
const assert = require('node:assert/strict')
const {loadTs} = require('../../test/helpers/load-ts')
const {forcedRules} = require('../../test/helpers/netlify-redirects')

const {redirects} = loadTs('src/redirects.ts')

test('every old URL has exactly one redirect', () => {
  const seen = new Map()
  const duplicates = []
  for (const {from, to} of redirects) {
    if (seen.has(from)) duplicates.push(`${from} -> ${seen.get(from)} and ${to}`)
    seen.set(from, to)
  }
  assert.deepEqual(duplicates, [])
})

test('no redirect points at itself or at another redirect', () => {
  const froms = new Set(redirects.map((r) => r.from))
  assert.deepEqual(redirects.filter((r) => r.from === r.to), [])
  assert.deepEqual(redirects.filter((r) => froms.has(r.to)), [])
})

// With trailingSlash: false a page is served at `/x`, so a redirect written for `/x/` or `/x.html` never fires.
test('old URLs are root-relative paths in the site\'s URL form', () => {
  const bad = redirects.filter(({from}) => !from.startsWith('/') || from.endsWith('/') || from.endsWith('.html') || /[?#]/.test(from))
  assert.deepEqual(bad, [])
})

// Netlify applies a forced (`!`) rule before serving any file, so a client redirect under it can never run.
test('no client redirect is shadowed by a forced host rule in static/_redirects', () => {
  const forced = forcedRules()
  assert.ok(forced.length > 0, 'static/_redirects has forced rules to check against')
  const shadowed = redirects.flatMap(({from}) => forced.filter(({re}) => re.test(from)).map((rule) => `${from} (by ${rule.from})`))
  assert.deepEqual(shadowed, [])
})
