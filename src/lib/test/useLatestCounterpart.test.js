'use strict'

// Spec: on a page of an older version, the counterpart is the latest release's page with the same URL below the
// version segment. Doc ids follow the source tree, which is reorganized between releases while URLs are preserved,
// so the match must be by URL and never by id.

const test = require('node:test')
const assert = require('node:assert/strict')
const {client, loadTs} = require('../../../test/helpers/load-ts')

const useLatestCounterpart = loadTs('src/lib/useLatestCounterpart.ts')

const version = (name, isLast, docs) => ({
  name,
  isLast,
  path: `/hazelcast/${name}`,
  docs: Object.entries(docs).map(([suffix, id]) => ({id, path: `/hazelcast/${name}${suffix}`})),
})

const LATEST = version('5.7', true, {
  '/getting-started/install-hazelcast': 'install-and-upgrade/community-edition/install-hazelcast',
  '/maps': 'data-structures/maps',
  '/moved-here': 'old/place',
  '': 'index',
})
const SNAPSHOT = version('6.0-snapshot', false, {'/maps': 'data-structures/maps'})
const OLD = version('5.3', false, {
  '/getting-started/install-hazelcast': 'deploy-clusters/installation/install-hazelcast',
  '/maps': 'data-structures/maps',
  '/maps/eviction': 'data-structures/eviction',
  '/removed': 'old/place',
})

function on (pathname, activeVersion, versions = [SNAPSHOT, LATEST, OLD]) {
  client.pathname = pathname
  client.active = activeVersion && {activePlugin: {pluginData: {versions}}, activeVersion}
  return useLatestCounterpart()
}

test('the counterpart is found by URL when the doc id differs between versions', () => {
  const result = on('/hazelcast/5.3/getting-started/install-hazelcast', OLD)
  assert.equal(result.latest, LATEST)
  assert.equal(result.path, '/hazelcast/5.7/getting-started/install-hazelcast')
})

test('an unreleased snapshot also points at the latest release, not at itself', () => {
  assert.equal(on('/hazelcast/6.0-snapshot/maps', SNAPSHOT).path, '/hazelcast/5.7/maps')
})

test('a trailing slash on the current URL still finds the page', () => {
  assert.equal(on('/hazelcast/5.3/maps/', OLD).path, '/hazelcast/5.7/maps')
})

test('matching is exact: a page does not borrow the counterpart of its parent path', () => {
  const result = on('/hazelcast/5.3/maps/eviction', OLD)
  assert.equal(result.latest, LATEST)
  assert.equal(result.path, undefined)
})

test('a shared doc id is not a counterpart when the URL differs', () => {
  const result = on('/hazelcast/5.3/removed', OLD)
  assert.equal(result.path, undefined)
})

test('the version root maps to the latest version root', () => {
  const old = version('5.3', false, {'': 'index'})
  assert.equal(on('/hazelcast/5.3', old, [LATEST, old]).path, '/hazelcast/5.7')
})

test('there is no counterpart on the latest release itself, or outside the docs', () => {
  assert.equal(on('/hazelcast/5.7/maps', LATEST), undefined)
  assert.equal(on('/', undefined), undefined)
})

test('a docs instance with no release marked latest has no counterpart', () => {
  const unmarked = {...LATEST, isLast: false}
  assert.equal(on('/hazelcast/5.3/maps', OLD, [unmarked, OLD]), undefined)
})
