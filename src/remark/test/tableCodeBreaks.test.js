'use strict'

// Spec: inline code anywhere inside a Markdown table cell or an HTML <td>/<th> becomes <TableCodeBreaks> with the same text;
// inline code outside tables is untouched.

const test = require('node:test')
const assert = require('node:assert/strict')
const {loadTs} = require('../../../test/helpers/load-ts')

const tableCodeBreaks = loadTs('src/remark/tableCodeBreaks.ts')

const code = (value) => ({type: 'inlineCode', value})
const run = (tree) => { tableCodeBreaks()(tree); return tree }
const isTableCode = (n, value) =>
  n.type === 'mdxJsxTextElement' && n.name === 'TableCodeBreaks' && n.children.length === 1 && n.children[0].value === value

test('Markdown table cell, including code nested in emphasis', () => {
  const cell = {type: 'tableCell', children: [code('a'), {type: 'strong', children: [code('b')]}]}
  run({type: 'root', children: [{type: 'table', children: [{type: 'tableRow', children: [cell]}]}]})
  assert.ok(isTableCode(cell.children[0], 'a'))
  assert.ok(isTableCode(cell.children[1].children[0], 'b'))
})

test('HTML td and th, including code in a paragraph inside the cell', () => {
  for (const name of ['td', 'th']) {
    const p = {type: 'paragraph', children: [code('x')]}
    run({type: 'root', children: [{type: 'mdxJsxFlowElement', name, attributes: [], children: [p]}]})
    assert.ok(isTableCode(p.children[0], 'x'), name)
  }
})

test('a code Variable in a cell gets `breaks`; one outside a cell, or without `code`, does not', () => {
  const variable = (...names) => ({type: 'mdxJsxTextElement', name: 'Variable', attributes: names.map((name) => ({type: 'mdxJsxAttribute', name})), children: []})
  const inCell = variable('href', 'code'), plain = variable('href'), outside = variable('href', 'code')
  run({type: 'root', children: [{type: 'tableCell', children: [inCell, plain]}, {type: 'paragraph', children: [outside]}]})
  const has = (n) => n.attributes.some((a) => a.name === 'breaks')
  assert.ok(has(inCell))
  assert.ok(!has(plain))
  assert.ok(!has(outside))
})

test('code outside a table cell is left alone', () => {
  const p = {type: 'paragraph', children: [code('x')]}
  run({type: 'root', children: [p, {type: 'mdxJsxFlowElement', name: 'table', attributes: [], children: []}]})
  assert.deepEqual(p.children[0], code('x'))
})
