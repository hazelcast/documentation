'use strict'

// Spec: an imported example file shows only the region its import asks for, with each {attribute} replaced by the
// value <Variable> would render on a page of the same component and version.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const {site, client, loadTs} = require('../../../test/helpers/load-ts')
const exampleAttributes = require('..')
const attributesLoader = require('../attributes-loader')
const tagSliceLoader = require('../tag-slice-loader')

const Variable = loadTs('src/components/Variable.tsx')
const {variables, versionedVariables} = loadTs('src/variables.ts')

const OPTIONS = {variables, versionedVariables}

const run = (loader, source, resourcePath, {query = '', options = OPTIONS} = {}) =>
  loader.call({resourcePath, resourceQuery: query, getOptions: () => options}, source)

function rendered (pluginId, versionName, name) {
  client.active = {activePlugin: {pluginId}, activeVersion: {name: versionName}}
  return renderToStaticMarkup(React.createElement(Variable, {name}))
}

// A per-version variable whose value in one release differs from current.
function divergent () {
  for (const [pluginId, byVersion] of Object.entries(versionedVariables)) {
    for (const [version, vars] of Object.entries(byVersion)) {
      if (version === 'current') continue
      for (const [name, value] of Object.entries(vars)) {
        const current = byVersion.current?.[name] ?? variables[name]
        if (current !== undefined && current !== value) return {pluginId, version, name}
      }
    }
  }
  throw new Error('no per-version variable differs from current in src/variables.ts')
}

test('an example in a release shows that release\'s value, and one in main shows the current value', () => {
  const {pluginId, version, name} = divergent()
  const released = path.join(site, `${pluginId}_versioned_docs`, `version-${version}`, 'examples', 'A.java')
  const current = path.join(site, pluginId, 'examples', 'A.java')
  assert.equal(run(attributesLoader, `v={${name}}`, released), `v=${rendered(pluginId, version, name)}`)
  assert.equal(run(attributesLoader, `v={${name}}`, current), `v=${rendered(pluginId, 'current', name)}`)
  assert.notEqual(run(attributesLoader, `{${name}}`, released), run(attributesLoader, `{${name}}`, current))
})

test('a component with no per-version values gets the global values', () => {
  const name = Object.keys(variables)[0]
  const file = path.join(site, 'tutorials', 'examples', 'x.yaml')
  assert.equal(run(attributesLoader, `{${name}}`, file), rendered('tutorials', 'current', name))
})

test('unknown and escaped references stay literal', () => {
  const file = path.join(site, 'hazelcast', 'examples', 'A.java')
  const name = Object.keys(variables)[0]
  assert.equal(run(attributesLoader, `{no-such-variable} \\{${name}}`, file), `{no-such-variable} {${name}}`)
})

test('the import query selects the region: tag, tag list, lines and indent', () => {
  const file = path.join(site, 'hazelcast', 'examples', 'A.java')
  const src = 'package a;\n//tag::x[]\n    X();\n//end::x[]\n//tag::y[]\n    Y();\n//end::y[]\n'
  assert.equal(run(tagSliceLoader, src, file, {query: '?tag=x'}), '    X();\n')
  assert.equal(run(tagSliceLoader, src, file, {query: '?tag=x&indent=0'}), 'X();\n')
  assert.equal(run(tagSliceLoader, src, file, {query: `?tags=${encodeURIComponent('x;y')}`}), '    X();\n    Y();\n')
  assert.equal(run(tagSliceLoader, src, file, {query: '?tags=%21x'}), 'package a;\n    Y();\n')
  assert.equal(run(tagSliceLoader, src, file, {query: '?lines=1'}), 'package a;\n')
})

test('with no query the whole file passes through, without a BOM', () => {
  const file = path.join(site, 'hazelcast', 'examples', 'A.java')
  assert.equal(run(tagSliceLoader, '﻿whole\n\n', file), 'whole\n\n')
})

test('an import naming a region the file lacks fails the build, naming the file', () => {
  const file = path.join(site, 'hazelcast', 'examples', 'A.java')
  assert.throws(() => run(tagSliceLoader, '//tag::x[]\nX\n//end::x[]\n', file, {query: '?tag=gone'}), /A\.java: no region tagged "gone"/)
})

function rule () {
  const {module} = exampleAttributes({}, OPTIONS).configureWebpack()
  assert.equal(module.rules.length, 1)
  return module.rules[0]
}

test('the loaders apply to example files only', () => {
  const {test: matches} = rule()
  for (const p of [
    'hazelcast/examples/dds/A.java',
    'hazelcast_versioned_docs/version-5.6/examples/config/hazelcast.yaml',
    '.tutorial-examples/demo/client.py',
    '.tutorial-examples/demo/client.js',
    'operator/examples/cr.yaml',
  ]) assert.ok(matches.test(path.join(site, p)), p)
  for (const p of [
    'hazelcast/maps/overview.mdx',
    'src/components/Variable.tsx',
    'plugins/example-attributes/index.js',
    'hazelcast/examples/diagram.png',
  ]) assert.ok(!matches.test(path.join(site, p)), p)
})

// webpack applies `use` right to left.
test('applied as webpack chains them, a region is sliced and then its attributes are replaced', () => {
  const {use} = rule()
  const loaders = [...use].reverse().filter((u) => u !== 'raw-loader').map((u) => require(typeof u === 'string' ? u : u.loader))
  const {pluginId, version, name} = divergent()
  const file = path.join(site, `${pluginId}_versioned_docs`, `version-${version}`, 'examples', 'A.java')
  const out = loaders.reduce((src, loader) => run(loader, src, file, {query: '?tag=x'}), `skip\n//tag::x[]\nv={${name}}\n//end::x[]\n`)
  assert.equal(out, `v=${rendered(pluginId, version, name)}\n`)
  assert.equal(use[0], 'raw-loader', 'the result is imported as a string')
})
