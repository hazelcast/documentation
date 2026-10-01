'use strict'

// Spec: a <Variable name/> in a heading shows the same text in the page's table of contents as <Variable> renders
// in the heading itself, for the version the page belongs to. Oracles: Docusaurus's own headings + TOC plugins
// build the TOC, and the real <Variable> component renders the body text.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const {site, client, loadTs} = require('../../../test/helpers/load-ts')

const headingVariables = loadTs('src/remark/headingVariables.ts')
const Variable = loadTs('src/components/Variable.tsx')
const {variables, versionedVariables} = loadTs('src/variables.ts')
const headings = require('@docusaurus/mdx-loader/lib/remark/headings').default
const toc = require('@docusaurus/mdx-loader/lib/remark/toc').default

async function tocOf (mdx, file, {withPlugin = true, pluginId} = {}) {
  const {evaluate} = await import('@mdx-js/mdx')
  const runtime = require('react/jsx-runtime')
  // Docusaurus's order: beforeDefaultRemarkPlugins, then its headings and TOC plugins.
  const remarkPlugins = [
    ...(withPlugin ? [[headingVariables, {pluginId}]] : []),
    [headings, {anchorsMaintainCase: false}],
    toc,
  ]
  const mod = await evaluate({value: mdx, path: file}, {...runtime, remarkPlugins})
  return mod.toc.map((entry) => entry.value)
}

function rendered (pluginId, versionName, name) {
  client.active = {activePlugin: {pluginId}, activeVersion: {name: versionName}}
  return renderToStaticMarkup(React.createElement(Variable, {name}))
}

// A variable whose value differs between the current version and an older release, so the wrong version shows.
function divergentVariable () {
  for (const [pluginId, byVersion] of Object.entries(versionedVariables)) {
    const current = byVersion.current ?? {}
    for (const [version, vars] of Object.entries(byVersion)) {
      if (version === 'current') continue
      for (const [name, value] of Object.entries(vars)) {
        const other = current[name] ?? variables[name]
        if (other !== undefined && other !== value) return {pluginId, version, name}
      }
    }
  }
  throw new Error('no per-version variable differs from current in src/variables.ts')
}

test('without the plugin the TOC loses the value (the problem is real)', async () => {
  const {pluginId, name} = divergentVariable()
  const file = path.join(site, pluginId, 'page.mdx')
  const [entry] = await tocOf(`## Install <Variable name="${name}"/>\n`, file, {withPlugin: false, pluginId})
  assert.notEqual(entry, `Install ${rendered(pluginId, 'current', name)}`)
})

test('the TOC entry matches what <Variable> renders, for current and for a release', async () => {
  const {pluginId, version, name} = divergentVariable()
  const cases = [
    {file: path.join(site, pluginId, 'dir/page.mdx'), versionName: 'current'},
    {file: path.join(site, `${pluginId}_versioned_docs`, `version-${version}`, 'dir/page.mdx'), versionName: version},
  ]
  const seen = new Set()
  for (const {file, versionName} of cases) {
    const [entry] = await tocOf(`## Install <Variable name="${name}"/> now\n`, file, {pluginId})
    const expected = `Install ${rendered(pluginId, versionName, name)} now`
    assert.equal(entry, expected, `${path.relative(site, file)}`)
    seen.add(entry)
  }
  assert.equal(seen.size, 2, 'current and the release show different values')
})

test('an unknown name renders as the name, in the TOC as in the body', async () => {
  const file = path.join(site, 'hazelcast', 'page.mdx')
  const [entry] = await tocOf('## Use <Variable name="no-such-variable"/>\n', file, {pluginId: 'hazelcast'})
  assert.equal(entry, `Use ${rendered('hazelcast', 'current', 'no-such-variable')}`)
})

test('a global variable resolves in a component with no per-version values', async () => {
  const name = Object.keys(variables)[0]
  const file = path.join(site, 'cloud', 'page.mdx')
  const [entry] = await tocOf(`## A <Variable name="${name}"/>\n`, file, {pluginId: 'cloud'})
  assert.equal(entry, `A ${rendered('cloud', 'current', name)}`)
})

test('only headings change: a <Variable> in body text is left for the component to render', async () => {
  const tree = {
    type: 'root',
    children: [{type: 'paragraph', children: [{type: 'mdxJsxTextElement', name: 'Variable', attributes: [{type: 'mdxJsxAttribute', name: 'name', value: Object.keys(variables)[0]}], children: []}]}],
  }
  headingVariables({pluginId: 'hazelcast'})(tree, {path: path.join(site, 'hazelcast', 'page.mdx')})
  assert.equal(tree.children[0].children[0].type, 'mdxJsxTextElement')
})
