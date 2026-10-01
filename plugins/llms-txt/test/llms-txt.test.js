'use strict'

// Spec: /llms.txt follows llmstxt.org (an H1 with the site name, a blockquote summary, then H2 sections of
// `- [title](url): description` links) and lists every published page of each product's current release, once, in
// sidebar order. The output is read back with remark, a Markdown parser independent of the generator.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const llmsTxt = require('..')

const SITE = {
  title: 'Hazelcast Documentation',
  tagline: 'Docs for Hazelcast',
  url: 'https://docs.hazelcast.com',
  baseUrl: '/',
  trailingSlash: false,
  themeConfig: {
    navbar: {
      items: [
        {type: 'docSidebar', docsPluginId: 'hazelcast', label: 'Platform'},
        {type: 'dropdown', label: 'More'},
        {type: 'docSidebar', docsPluginId: 'cloud', label: 'Cloud'},
      ],
    },
  },
}

const doc = (id, permalink, extra = {}) => ({id, title: id.toUpperCase(), description: `About ${id}.`, permalink, ...extra})

function docsPlugin (id, versions) {
  return {name: 'docusaurus-plugin-content-docs', options: {id, routeBasePath: id}, content: {loadedVersions: versions}}
}

const tmpDirs = []
test.after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})))

async function generate (plugins, siteConfig = SITE) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llms-txt-'))
  tmpDirs.push(outDir)
  const log = console.log
  console.log = () => {}
  try {
    await llmsTxt().postBuild({outDir, siteConfig, plugins})
  } finally {
    console.log = log
  }
  return fs.readFileSync(path.join(outDir, 'llms.txt'), 'utf8')
}

async function parse (text) {
  const {unified} = await import('unified')
  const {default: remarkParse} = await import('remark-parse')
  return unified().use(remarkParse).parse(text)
}

const textOf = (node) => node.value ?? (node.children ?? []).map(textOf).join('')

// Sections as {heading, depth, links: [{text, url, rest}]}, in document order.
async function outline (text) {
  const tree = await parse(text)
  const sections = []
  for (const node of tree.children) {
    if (node.type === 'heading') sections.push({heading: textOf(node), depth: node.depth, links: []})
    if (node.type === 'list') {
      for (const item of node.children) {
        const [para] = item.children
        const [link, ...rest] = para.children
        assert.equal(link.type, 'link', `list item starts with a link: ${textOf(para)}`)
        sections.at(-1).links.push({text: textOf(link), url: link.url, rest: rest.map(textOf).join('')})
      }
    }
  }
  return {tree, sections}
}

const PLATFORM = docsPlugin('hazelcast', [
  {
    isLast: false,
    path: '/hazelcast/6.0-snapshot',
    docs: [doc('snapshot-only', '/hazelcast/6.0-snapshot/snapshot-only')],
    sidebars: {defaultSidebar: [{type: 'doc', id: 'snapshot-only'}]},
  },
  {
    isLast: true,
    path: '/hazelcast/5.7',
    docs: [
      doc('intro', '/hazelcast/5.7/intro'),
      doc('maps', '/hazelcast/5.7/maps'),
      doc('maps-eviction', '/hazelcast/5.7/maps-eviction'),
      doc('sql', '/hazelcast/5.7/sql'),
      doc('orphan', '/hazelcast/5.7/orphan'),
      doc('draft', '/hazelcast/5.7/draft', {draft: true}),
      doc('hidden', '/hazelcast/5.7/hidden', {unlisted: true}),
    ],
    sidebars: {
      defaultSidebar: [
        {type: 'doc', id: 'intro'},
        {
          type: 'category',
          label: 'Data structures',
          link: {type: 'doc', id: 'maps'},
          items: [
            {type: 'category', label: 'Eviction', link: {type: 'generated-index'}, items: [{type: 'doc', id: 'maps-eviction'}]},
            {type: 'link', href: 'https://example.com', label: 'External'},
            {type: 'doc', id: 'intro'},
            {type: 'doc', id: 'draft'},
          ],
        },
        {type: 'category', label: 'SQL', items: [{type: 'ref', id: 'sql'}, {type: 'doc', id: 'hidden'}]},
      ],
    },
  },
])

const CLOUD = docsPlugin('cloud', [
  {isLast: true, path: '/cloud', docs: [doc('overview', '/cloud/overview')], sidebars: {defaultSidebar: [{type: 'doc', id: 'overview'}]}},
])

test('the file opens with the site title as H1 and the tagline as a blockquote', async () => {
  const {tree} = await outline(await generate([CLOUD]))
  assert.equal(tree.children[0].type, 'heading')
  assert.equal(tree.children[0].depth, 1)
  assert.equal(textOf(tree.children[0]), SITE.title)
  assert.equal(tree.children[1].type, 'blockquote')
  assert.equal(textOf(tree.children[1]), SITE.tagline)
})

test('each product is an H2 named as in the navbar, in navbar order, with its release segment when versioned', async () => {
  const {sections} = await outline(await generate([CLOUD, PLATFORM]))
  assert.deepEqual(sections.filter((s) => s.depth === 2).map((s) => s.heading), ['Platform 5.7', 'Cloud'])
})

test('a docs instance the navbar does not name is listed last, under its id in title case', async () => {
  const other = docsPlugin('management-center', [
    {isLast: true, path: '/management-center/5.11', docs: [doc('a', '/management-center/5.11/a')], sidebars: {s: [{type: 'doc', id: 'a'}]}},
  ])
  const {sections} = await outline(await generate([other, CLOUD, PLATFORM]))
  assert.deepEqual(sections.filter((s) => s.depth === 2).map((s) => s.heading), ['Platform 5.7', 'Cloud', 'Management Center 5.11'])
})

test('only the release marked isLast is indexed', async () => {
  const text = await generate([PLATFORM])
  assert.ok(!text.includes('snapshot-only'))
  assert.ok(!text.includes('/6.0-snapshot/'))
})

test('pages follow sidebar order: loose pages, then one H3 per top-level category, then unreachable pages', async () => {
  const {sections} = await outline(await generate([PLATFORM]))
  const platform = sections.slice(sections.findIndex((s) => s.heading === 'Platform 5.7'))
  assert.deepEqual(platform.map((s) => [s.heading, s.links.map((l) => l.text)]), [
    ['Platform 5.7', ['INTRO']],
    ['Data structures', ['MAPS', 'MAPS-EVICTION']],
    ['SQL', ['SQL']],
    ['Other pages', ['ORPHAN']],
  ])
})

test('drafts and unlisted pages are left out, and a page the sidebar reaches twice is listed once', async () => {
  const text = await generate([PLATFORM])
  assert.ok(!text.includes('/draft'))
  assert.ok(!text.includes('/hidden'))
  assert.equal(text.split('/hazelcast/5.7/intro)').length - 1, 1)
})

test('links are absolute URLs on the site origin, without a trailing slash', async () => {
  const plugin = docsPlugin('cloud', [
    {isLast: true, path: '/cloud', docs: [doc('a', '/cloud/a/')], sidebars: {s: [{type: 'doc', id: 'a'}]}},
  ])
  const {sections} = await outline(await generate([plugin]))
  assert.equal(sections.find((s) => s.heading === 'Cloud').links[0].url, 'https://docs.hazelcast.com/cloud/a')
})

test('a description is one line, capped at 200 characters on a word boundary; a page without one has no colon', async () => {
  const long = Array.from({length: 60}, (_, i) => `word${i}`).join(' ')
  const plugin = docsPlugin('cloud', [
    {
      isLast: true,
      path: '/cloud',
      docs: [
        doc('multi', '/cloud/multi', {description: 'Line one.\n\n  Line   two.'}),
        doc('long', '/cloud/long', {description: long}),
        doc('none', '/cloud/none', {description: ''}),
      ],
      sidebars: {s: [{type: 'doc', id: 'multi'}, {type: 'doc', id: 'long'}, {type: 'doc', id: 'none'}]},
    },
  ])
  const text = await generate([plugin])
  const line = (id) => text.split('\n').find((l) => l.includes(`/cloud/${id})`))
  assert.ok(line('multi').endsWith('): Line one. Line two.'))
  const description = line('long').split('): ')[1]
  assert.ok(description.length <= 201, 'at most 200 characters plus the ellipsis')
  assert.ok(description.endsWith('…'))
  assert.ok(long.startsWith(description.slice(0, -1)), 'cut at a word boundary of the original')
  assert.ok(!long.startsWith(description.slice(0, -1) + 'x'))
  assert.ok(line('none').endsWith('(https://docs.hazelcast.com/cloud/none)'))
})

test('the same input produces byte-identical output', async () => {
  assert.equal(await generate([PLATFORM, CLOUD]), await generate([PLATFORM, CLOUD]))
})

test('the build fails rather than publish an index with a product missing or nothing in it', async () => {
  const noLast = docsPlugin('hazelcast', [{isLast: false, path: '/hazelcast/x', docs: [], sidebars: {}}])
  await assert.rejects(generate([noLast]), /'hazelcast' has no version marked isLast/)
  await assert.rejects(generate([{name: 'other-plugin', options: {}}]), /nothing to index/)
})
