'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { pageMap, renderComment, commentOnPr } = require('..')

const PREVIEW = 'https://deploy-preview-45--hazelcast-documentation.netlify.app'

const docsPlugin = (id, versions) => ({ name: 'docusaurus-plugin-content-docs', options: { id, routeBasePath: `/${id}` }, content: { loadedVersions: versions } })
const SITE = { themeConfig: { navbar: { items: [{ type: 'docSidebar', docsPluginId: 'hazelcast', label: 'Platform' }] } } }

test('maps each doc source to its section, title, URL, and path', () => {
  const plugins = [
    docsPlugin('hazelcast', [
      { label: '6.0-SNAPSHOT', path: '/hazelcast/6.0-snapshot', docs: [{ source: '@site/hazelcast/sql/index.mdx', title: 'SQL', permalink: '/hazelcast/6.0-snapshot/sql' }] },
      { label: '5.7', path: '/hazelcast/5.7', docs: [{ source: '@site/hazelcast_versioned_docs/version-5.7/index.mdx', title: 'Overview', permalink: '/hazelcast/5.7/' }] },
    ]),
    docsPlugin('operator', [{ label: 'Next', path: '/operator/latest-snapshot', docs: [{ source: '@site/operator/a.mdx', title: 'A', permalink: '/operator/latest-snapshot/a' }] }]),
    docsPlugin('tutorials', [{ label: 'Next', path: '/tutorials', docs: [{ source: '@site/tutorials/t.mdx', title: 'T', permalink: '/tutorials/t' }] }]),
    { name: 'other-plugin', content: {} },
  ]
  assert.deepEqual(pageMap(plugins, SITE), {
    'hazelcast/sql/index.mdx': { section: 'Platform 6.0-SNAPSHOT', title: 'SQL', url: '/hazelcast/6.0-snapshot/sql', path: 'sql' },
    'hazelcast_versioned_docs/version-5.7/index.mdx': { section: 'Platform 5.7', title: 'Overview', url: '/hazelcast/5.7/', path: '' },
    'operator/a.mdx': { section: 'Operator latest-snapshot', title: 'A', url: '/operator/latest-snapshot/a', path: 'a' },
    'tutorials/t.mdx': { section: 'Tutorials', title: 'T', url: '/tutorials/t', path: 't' },
  })
})

const page = (section, path, title = path) => ({ section, title, url: `/${section.toLowerCase().replace(/ /g, '/')}/${path}`, path })

test('lists changed pages under one heading per section and skips files with no page', () => {
  const pages = {
    'hazelcast/sql/index.mdx': page('Platform 6.0', 'sql', 'SQL'),
    'cloud/overview.mdx': page('Cloud', 'overview', 'Overview'),
    'cloud/unchanged.mdx': page('Cloud', 'unchanged'),
  }
  const files = ['cloud/overview.mdx', 'hazelcast/_partials/note.mdx', 'hazelcast/sql/index.mdx', 'README.md']
  assert.equal(renderComment(files, pages, PREVIEW + '/'), [
    '### Deploy Preview links',
    '',
    'Direct links to changed pages.',
    '',
    '**Platform 6.0**',
    '',
    `- [SQL](${PREVIEW}/platform/6.0/sql) \`sql\``,
    '',
    '**Cloud**',
    '',
    `- [Overview](${PREVIEW}/cloud/overview) \`overview\``,
    '',
  ].join('\n'))
})

const cloudPages = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`cloud/p${i}.mdx`, page('Cloud', `p${i}`)]))

test('puts links after the eighth in a dropdown', () => {
  const pages = cloudPages(10)
  assert.equal(renderComment(Object.keys(pages), pages, PREVIEW), [
    '### Deploy Preview links',
    '',
    'Direct links to changed pages.',
    '',
    '**Cloud**',
    '',
    ...Array.from({ length: 8 }, (_, i) => `- [p${i}](${PREVIEW}/cloud/p${i}) \`p${i}\``),
    '',
    '<details>',
    '<summary>2 more</summary>',
    '',
    `- [p8](${PREVIEW}/cloud/p8) \`p8\``,
    `- [p9](${PREVIEW}/cloud/p9) \`p9\``,
    '',
    '</details>',
    '',
  ].join('\n'))
})

test('lists at most 20 links per section and counts the rest', () => {
  const pages = cloudPages(1500)
  const lines = renderComment(Object.keys(pages), pages, PREVIEW).trimEnd().split('\n')
  assert.equal(lines.filter((line) => line.startsWith('- [')).length, 20)
  assert.ok(lines.includes('<summary>1492 more</summary>'))
  assert.ok(lines.includes('- ...and 1480 more, too many to list'))
})

test('prints nothing when no page changed', () => {
  assert.equal(renderComment(['README.md'], {}, PREVIEW), '')
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
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: { 'cloud/overview.mdx': page('Cloud', 'overview', 'Overview') } })
  assert.deepEqual(requests.at(-1), {
    method: 'POST',
    url: '/repos/hazelcast/documentation/issues/53/comments',
    body: { body: `### Deploy Preview links\n\nDirect links to changed pages.\n\n**Cloud**\n\n- [Overview](${PREVIEW}/cloud/overview) \`overview\`\n` },
  })
})

test('edits the earlier comment', async (t) => {
  const requests = fakeGitHub(t, {
    'GET /repos/hazelcast/documentation/pulls/53/files': [{ filename: 'cloud/a.mdx' }, { filename: 'cloud/b.mdx' }],
    'GET /repos/hazelcast/documentation/issues/53/comments': [{ id: 7, body: '### Deploy Preview links\n' }],
  })
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: { 'cloud/a.mdx': page('Cloud', 'a'), 'cloud/b.mdx': page('Cloud', 'b') } })
  assert.equal(requests.at(-1).method, 'PATCH')
  assert.equal(requests.at(-1).url, '/repos/hazelcast/documentation/issues/comments/7')
})

test('posts nothing when no page changed', async (t) => {
  const requests = fakeGitHub(t, {
    'GET /repos/hazelcast/documentation/pulls/53/files': [{ filename: 'README.md' }],
    'GET /repos/hazelcast/documentation/issues/53/comments': [],
  })
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: {} })
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'GET'])
})

test('deletes the earlier comment when no page changed', async (t) => {
  const requests = fakeGitHub(t, {
    'GET /repos/hazelcast/documentation/pulls/53/files': [{ filename: 'README.md' }],
    'GET /repos/hazelcast/documentation/issues/53/comments': [{ id: 7, body: '### Deploy Preview links\n' }],
  })
  await commentOnPr({ token: 't', pr: '53', previewUrl: PREVIEW, pages: {} })
  assert.deepEqual(requests.at(-1), { method: 'DELETE', url: '/repos/hazelcast/documentation/issues/comments/7', body: undefined })
})

test('orders sections like the navbar, with products it does not list last', () => {
  const site = { themeConfig: { navbar: { items: [
    { type: 'dropdown', label: 'Products' },
    { type: 'docSidebar', docsPluginId: 'hazelcast', label: 'Platform' },
    { type: 'docSidebar', docsPluginId: 'operator', label: 'Operator' },
  ] } } }
  const doc = (id) => ({ label: 'Next', path: `/${id}`, docs: [{ source: `@site/${id}/a.mdx`, title: 'A', permalink: `/${id}/a` }] })
  const plugins = [docsPlugin('tutorials', [doc('tutorials')]), docsPlugin('operator', [doc('operator')]), docsPlugin('hazelcast', [doc('hazelcast')])]
  assert.deepEqual(Object.values(pageMap(plugins, site)).map((page) => page.section), ['Platform', 'Operator', 'Tutorials'])
})
