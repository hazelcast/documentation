'use strict'

// Spec: Asciidoctor's attribute-reference substitution (`subs=attributes+`, attribute-missing: skip) for the
// `{name}` form. Expectations were checked against @asciidoctor/core.

const test = require('node:test')
const assert = require('node:assert/strict')
const substitute = require('../substitute-attributes')

const ATTRS = {'full-version': '5.7.1', 'os-version': '9', b: '{full-version}', dollar: '$& $1 $$'}

test('a reference is replaced by its value, including several on one line', () => {
  assert.equal(substitute('{full-version}', ATTRS), '5.7.1')
  assert.equal(substitute('v{os-version}-{full-version}', ATTRS), 'v9-5.7.1')
})

test('an unknown name stays literal, including names that exist on Object.prototype', () => {
  assert.equal(substitute('{missing}', ATTRS), '{missing}')
  assert.equal(substitute('{constructor} {toString}', ATTRS), '{constructor} {toString}')
})

test('a backslash escapes a reference: the literal reference renders, without the backslash', () => {
  assert.equal(substitute('\\{full-version}', ATTRS), '{full-version}')
  assert.equal(substitute('\\{missing}', ATTRS), '{missing}')
})

test('substitution is one pass: a value that looks like a reference is not expanded again', () => {
  assert.equal(substitute('{b}', ATTRS), '{full-version}')
})

test('a value is inserted verbatim, with no replacement-pattern interpretation', () => {
  assert.equal(substitute('{dollar}', ATTRS), '$& $1 $$')
})

test('only valid attribute names are references', () => {
  for (const s of ['{-x}', '{full-version }', '{ full-version}', '{}', '{a.b}']) {
    assert.equal(substitute(s, {...ATTRS, '-x': 'no', 'a.b': 'no'}), s)
  }
})

test('non-string values are stringified', () => {
  assert.equal(substitute('{n}', {n: 7}), '7')
})
