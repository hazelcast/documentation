'use strict'

// Spec: `/<component>/latest-dev/...` takes a reader to the same page in the component's development line, `main`,
// wherever the host's redirect chain goes on the way. For a component whose `main` is an unreleased snapshot that is
// the snapshot; for one whose `main` is the newest release, it is that release. The `/latest/` alias is checked
// alongside the remark plugin that resolves it, in src/remark/test/latestLinks.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const {loadDocsPlugins} = require('../../test/helpers/docs-plugins')
const {follow} = require('../../test/helpers/netlify-redirects')

const {ids, configs} = loadDocsPlugins()

test('every versioned component has a latest-dev alias that ends on main', () => {
  for (const id of ids) {
    const main = `/${id}/${configs[id].versions.current.path}`
    for (const [url, expected] of [
      [`/${id}/latest-dev/some/page`, `${main}/some/page`],
      [`/${id}/latest-dev`, `${main}/`],
    ]) {
      assert.notEqual(follow(url), url, `static/_redirects has a /${id}/latest-dev/* alias`)
      assert.equal(follow(url), expected, url)
    }
  }
})

test('latest-dev and latest end on the same version exactly when main is the newest release', () => {
  for (const id of ids) {
    const {lastVersion} = configs[id]
    const same = follow(`/${id}/latest-dev/x`) === follow(`/${id}/latest/x`)
    assert.equal(same, lastVersion === 'current', id)
  }
})
