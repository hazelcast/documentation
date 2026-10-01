'use strict'

// Spec: on every version of every component, exactly one of `<IfSnapshot>` and `<IfNotSnapshot>` shows its content.
// `<IfSnapshot>` shows on the unreleased version only, which is the version whose pages stay out of the sitemap.
// The version banners come from Docusaurus's own logic, applied to the real site config.

const test = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const {client, loadTs} = require('../../../test/helpers/load-ts')
const {loadDocsPlugins} = require('../../../test/helpers/docs-plugins')

const IfSnapshot = loadTs('src/components/IfSnapshot.tsx')
const IfNotSnapshot = loadTs('src/components/IfNotSnapshot.tsx')
const {docsPlugins, ids, versionsOf} = loadDocsPlugins()

function shown (banner) {
  client.docsVersion = {banner}
  return renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(IfSnapshot, null, 'SNAPSHOT'),
    React.createElement(IfNotSnapshot, null, 'RELEASE')))
}

test('every version shows exactly one of the two, and the snapshot half on the unreleased version only', () => {
  const seen = new Set()
  for (const id of ids) {
    for (const {versionName, seg, banner} of versionsOf(id)) {
      const html = shown(banner)
      const expected = banner === 'unreleased' ? 'SNAPSHOT' : 'RELEASE'
      assert.equal(html, expected, `${id} ${versionName}`)
      assert.equal(expected === 'SNAPSHOT', docsPlugins.isSnapshotUrl(`https://docs.hazelcast.com/${id}/${seg}/page`),
        `${id} ${versionName}: the content flips on the same versions the sitemap leaves out`)
      seen.add(expected)
    }
  }
  assert.deepEqual([...seen].sort(), ['RELEASE', 'SNAPSHOT'], 'the site has both kinds of version')
})

test('a version with no banner, as on an unversioned component, is not a snapshot', () => {
  assert.equal(shown(null), 'RELEASE')
})
