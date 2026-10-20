'use strict'

// Spec: inline code in a table cell reads and copies exactly as written, and the browser may break it only at
// whitespace, after `/`, `_` or `.` inside a name, and between the words of a camelCase name.
// The oracle for a break opportunity is the rendered markup: a <wbr> or whitespace between `white-space: nowrap` spans.

const test = require('node:test')
const assert = require('node:assert/strict')
const cheerio = require('cheerio')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const {loadTs} = require('../../../test/helpers/load-ts')

const TableCodeBreaks = loadTs('src/components/TableCodeBreaks.tsx')

function render (code) {
  const $ = cheerio.load(renderToStaticMarkup(React.createElement(TableCodeBreaks, null, code)))
  const lines = []
  let line = ''
  for (const node of $('code').contents().toArray()) {
    if (node.type === 'text') { lines.push(line); line = ''; continue } // whitespace: a break opportunity
    if (node.name === 'wbr') { lines.push(line); line = ''; continue }
    assert.equal($(node).attr('style'), 'white-space:nowrap')
    line += $(node).text()
  }
  lines.push(line)
  return {text: $('code').text(), pieces: lines.filter(Boolean)}
}

const CASES = {
  'instance/losslessRestartEnabled': ['instance/', 'lossless', 'Restart', 'Enabled'],
  persistenceEnabled: ['persistence', 'Enabled'],
  '--value-type, -v': ['--value-type,', '-v'],
  hazelcast_jet_enabled: ['hazelcast_', 'jet_', 'enabled'],
  'hazelcast.map.size': ['hazelcast.', 'map.', 'size'],
  HTTPServer: ['HTTPServer'],
  '.mdx': ['.mdx'],
  name: ['name'],
}

test('breaks only at the allowed points', () => {
  for (const [code, pieces] of Object.entries(CASES)) assert.deepEqual(render(code).pieces, pieces, code)
})

test('the rendered text equals the code, so copying it is unchanged', () => {
  for (const code of [...Object.keys(CASES), 'a  b\tc', ' lead']) assert.equal(render(code).text, code)
})
