'use strict'

// Spec: `<Variable href text/>` is a link whose address and label have each `{name}` replaced by the value
// `<Variable name/>` renders for the same component and version. CONTRIBUTING.md documents this form for links that
// contain a version, such as a pom.xml at a release tag.

const test = require('node:test')
const assert = require('node:assert/strict')
const cheerio = require('cheerio')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const {client, loadTs} = require('../../../test/helpers/load-ts')

const Variable = loadTs('src/components/Variable.tsx')
const {variables, versionedVariables} = loadTs('src/variables.ts')

function render (pluginId, versionName, props) {
  client.active = {activePlugin: {pluginId}, activeVersion: {name: versionName}}
  return renderToStaticMarkup(React.createElement(Variable, props))
}

const value = (pluginId, versionName, name) => render(pluginId, versionName, {name})

function link (pluginId, versionName, props) {
  const $ = cheerio.load(render(pluginId, versionName, props))
  const a = $('a')
  assert.equal(a.length, 1, 'renders one link')
  return {href: a.attr('href'), text: a.text(), code: a.find('code').length > 0}
}

// Two variables whose values differ between `current` and one release of the same component.
function divergent () {
  for (const [pluginId, byVersion] of Object.entries(versionedVariables)) {
    for (const [version, vars] of Object.entries(byVersion)) {
      if (version === 'current') continue
      const names = Object.keys(vars).filter((name) => {
        const current = byVersion.current?.[name] ?? variables[name]
        return current !== undefined && current !== vars[name]
      })
      if (names.length >= 2) return {pluginId, version, names}
    }
  }
  throw new Error('no release has two variables that differ from current in src/variables.ts')
}

test('every {name} in the address and the label is replaced, using the page\'s own version', () => {
  const {pluginId, version, names: [a, b]} = divergent()
  for (const versionName of ['current', version]) {
    const got = link(pluginId, versionName, {href: `https://example.com/v{${a}}/x/{${b}}.xml`, text: `File for {${a}} and {${b}}`})
    assert.equal(got.href, `https://example.com/v${value(pluginId, versionName, a)}/x/${value(pluginId, versionName, b)}.xml`)
    assert.equal(got.text, `File for ${value(pluginId, versionName, a)} and ${value(pluginId, versionName, b)}`)
  }
  assert.notEqual(link(pluginId, 'current', {href: `{${a}}`, text: ''}).href, link(pluginId, version, {href: `{${a}}`, text: ''}).href)
})

test('an unknown name stays literal, and an escaped reference renders without its backslash', () => {
  const name = Object.keys(variables)[0]
  const got = link('hazelcast', 'current', {href: 'https://example.com/{no-such-variable}', text: `\\{${name}}`})
  assert.equal(got.href, 'https://example.com/{no-such-variable}')
  assert.equal(got.text, `{${name}}`)
})

test('`code` sets the label in monospace; without it the label is plain text', () => {
  const name = Object.keys(variables)[0]
  const props = {href: 'https://example.com', text: `{${name}}`}
  const plain = link('hazelcast', 'current', props)
  const code = link('hazelcast', 'current', {...props, code: true})
  assert.equal(plain.code, false)
  assert.equal(code.code, true)
  assert.equal(code.text, plain.text)
  assert.equal(code.text, value('hazelcast', 'current', name))
})

test('outside a versioned docs page, the global values are used', () => {
  const name = Object.keys(variables)[0]
  client.active = undefined
  const $ = cheerio.load(renderToStaticMarkup(React.createElement(Variable, {href: `https://example.com/{${name}}`, text: 'x'})))
  assert.equal($('a').attr('href'), `https://example.com/${variables[name]}`)
})
