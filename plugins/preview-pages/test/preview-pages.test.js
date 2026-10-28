'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { pageMap, renderComment, commentOnPr } = require('..')

const PREVIEW = 'https://deploy-preview-45--hazelcast-documentation.netlify.app'

const docsPlugin = (versions) => ({ name: 'docusaurus-plugin-content-docs', content: { loadedVersions: versions } })

test('maps each doc source in every version and instance to its permalink', () => {
  const plugins = [
    docsPlugin([
      { docs: [{ source: '@site/hazelcast/sql/index.mdx', permalink: '/hazelcast/6.0-snapshot/sql' }] },
      { docs: [{ source: '@site/hazelcast_versioned_docs/version-5.7/sql/index.mdx', permalink: '/hazelcast/5.7/sql' }] },
    ]),
    docsPlugin([{ docs: [{ source: '@site/cloud/overview.mdx', permalink: '/cloud/overview' }] }]),
    { name: 'other-plugin', content: {} },
  ]
  assert.deepEqual(pageMap(plugins), {
    'hazelcast/sql/index.mdx': '/hazelcast/6.0-snapshot/sql',
    'hazelcast_versioned_docs/version-5.7/sql/index.mdx': '/hazelcast/5.7/sql',
    'cloud/overview.mdx': '/cloud/overview',
  })
})

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

test('uses the singular for one page', () => {
  const pages = { 'cloud/overview.mdx': '/cloud/overview' }
  assert.match(renderComment(['cloud/overview.mdx'], pages, PREVIEW), /^Direct preview link to changed page:\n/)
})

// Replaces fetch with canned GitHub responses and records each request.
function fakeGitHub (t, responses) {
  const requests = []
  const realFetch = global.fetch
  t.after(() => { global.fetch = realFetch })
  global.fetch = async (url, { method, body }) => {
    requests.push({ method, url: url.replace('https://api.github.com', ''), body: body && JSON.parse(body) })
    const path = new URL(url).pathname
    return { ok: true, status: 200, json: async () => responses[`${method} ${path}`] ?? {} }
  }
  return requests
}

test('posts a comment when the PR has none', async (t) => {
  const requests = fakeGitHub(t, {
    'GET /repos/hazelcast/documentation/pulls/53/files': [{ filename: 'cloud/overview.mdx' }],
    'GET /repos/hazelcast/documentation/issues/53/comments': [{ id: 1, body: 'Deploy Preview ready!' }],
  })
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: { 'cloud/overview.mdx': '/cloud/overview' } })
  assert.deepEqual(requests.at(-1), {
    method: 'POST',
    url: '/repos/hazelcast/documentation/issues/53/comments',
    body: { body: `Direct preview link to changed page:\n\n- [/cloud/overview](${PREVIEW}/cloud/overview)\n` },
  })
})

test('edits the earlier comment, whichever heading it has', async (t) => {
  const requests = fakeGitHub(t, {
    'GET /repos/hazelcast/documentation/pulls/53/files': [{ filename: 'cloud/a.mdx' }, { filename: 'cloud/b.mdx' }],
    'GET /repos/hazelcast/documentation/issues/53/comments': [{ id: 7, body: 'Direct preview link to changed page:\n' }],
  })
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: { 'cloud/a.mdx': '/cloud/a', 'cloud/b.mdx': '/cloud/b' } })
  assert.equal(requests.at(-1).method, 'PATCH')
  assert.equal(requests.at(-1).url, '/repos/hazelcast/documentation/issues/comments/7')
})

test('posts nothing when no page changed', async (t) => {
  const requests = fakeGitHub(t, { 'GET /repos/hazelcast/documentation/pulls/53/files': [{ filename: 'README.md' }] })
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: {} })
  assert.deepEqual(requests.map((r) => r.method), ['GET'])
})
