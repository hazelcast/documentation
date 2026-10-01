'use strict'

// Spec: a link is unbuilt when it falls under a docs component but under none of that component's built versions.
// Every other link, including links outside any component, counts as built, so the build's broken-link check covers it.

const test = require('node:test')
const assert = require('node:assert/strict')
const {loadTs} = require('../../../test/helpers/load-ts')

const inUnbuiltVersion = loadTs('src/lib/inUnbuiltVersion.ts')

const component = (id, versions) => ({
  path: `/${id}`,
  versions: versions.map((name) => ({name, path: name === '' ? `/${id}` : `/${id}/${name}`})),
})

const SITE = {
  'management-center': component('management-center', ['5.12-snapshot', '5.11', '5.10', '5.9']),
  hazelcast: component('hazelcast', ['6.0-snapshot', '5.7', '5.3']),
  cloud: component('cloud', ['']),
}

test('a link into a built version is built', () => {
  assert.equal(inUnbuiltVersion('/management-center/5.11/clusters/clients', SITE), false)
  assert.equal(inUnbuiltVersion('/management-center/5.12-snapshot/clusters/clients', SITE), false)
  assert.equal(inUnbuiltVersion('/hazelcast/5.3', SITE), false)
})

test('a fragment or query does not affect the result', () => {
  assert.equal(inUnbuiltVersion('/management-center/5.11/clusters/clients#filtering', SITE), false)
  assert.equal(inUnbuiltVersion('/management-center/5.11/clusters/clients?x=1', SITE), false)
  assert.equal(inUnbuiltVersion('/management-center/5.3/clusters/clients#filtering', SITE), true)
})

test('a link into a version the site does not build is unbuilt', () => {
  assert.equal(inUnbuiltVersion('/management-center/5.3/clusters/clients', SITE), true)
  assert.equal(inUnbuiltVersion('/management-center/5.8', SITE), true)
  assert.equal(inUnbuiltVersion('/hazelcast/5.4/faq', SITE), true)
})

test('a version that is a prefix of another is matched by whole path segment', () => {
  assert.equal(inUnbuiltVersion('/management-center/5.1/clusters/clients', SITE), true)
  assert.equal(inUnbuiltVersion('/management-center/5.1', SITE), true)
  assert.equal(inUnbuiltVersion('/hazelcast/5.70/faq', SITE), true)
})

test('a component served without a version segment is always built', () => {
  assert.equal(inUnbuiltVersion('/cloud/getting-started', SITE), false)
  assert.equal(inUnbuiltVersion('/cloud', SITE), false)
})

test('a link outside every component is built', () => {
  assert.equal(inUnbuiltVersion('/privacy', SITE), false)
  assert.equal(inUnbuiltVersion('/', SITE), false)
  assert.equal(inUnbuiltVersion('/hazelcast-extra/5.3/page', SITE), false)
})
