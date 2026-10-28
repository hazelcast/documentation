'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { renderComment } = require('..')

const PREVIEW = 'https://deploy-preview-45--hazelcast-documentation.netlify.app'

test('links each changed page once and skips files with no page', () => {
  const pages = { 'hazelcast/sql/index.mdx': '/hazelcast/6.0-snapshot/sql', 'cloud/overview.mdx': '/cloud/overview' }
  const files = ['hazelcast/sql/index.mdx', 'hazelcast/_partials/note.mdx', 'cloud/overview.mdx', 'README.md']
  assert.equal(renderComment(files, pages, PREVIEW + '/'), [
    'Direct preview links to changed pages:',
    '',
    `- [/hazelcast/6.0-snapshot/sql](${PREVIEW}/hazelcast/6.0-snapshot/sql)`,
    `- [/cloud/overview](${PREVIEW}/cloud/overview)`,
    '',
  ].join('\n'))
})

test('caps the list and counts the rest', () => {
  const pages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`cloud/p${i}.mdx`, `/cloud/p${i}`]))
  const lines = renderComment(Object.keys(pages), pages, PREVIEW).trimEnd().split('\n')
  assert.equal(lines.length, 2 + 10 + 1)
  assert.equal(lines.at(-1), '- and 2 more')
})

test('prints nothing when no page changed', () => {
  assert.equal(renderComment(['README.md'], {}, PREVIEW), '')
})
