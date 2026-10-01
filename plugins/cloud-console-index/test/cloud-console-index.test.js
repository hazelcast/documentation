'use strict'

// Spec: /api/cloud.json is a contract with the Hazelcast Cloud console, defined by the Antora extension that produced
// it before this site: `{tags, links}`, each link `{title, url, tags, type, order}`, sorted by order, built from
// cloud_* page attributes, with `|` splitting one page into several entries.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cloudConsoleIndex = require('..')

const tmpDirs = []
test.after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})))

const frontMatter = (fm) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\nBody.\n`

async function cloudJson (pages) {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-console-'))
  const outDir = path.join(siteDir, 'build')
  tmpDirs.push(siteDir)
  for (const [rel, fm] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(siteDir, rel)), {recursive: true})
    fs.writeFileSync(path.join(siteDir, rel), frontMatter(fm))
  }
  fs.mkdirSync(path.join(siteDir, 'cloud'), {recursive: true})
  fs.mkdirSync(path.join(siteDir, 'tutorials'), {recursive: true})
  await cloudConsoleIndex({siteDir}).postBuild({outDir})
  return JSON.parse(fs.readFileSync(path.join(outDir, 'api', 'cloud.json'), 'utf8'))
}

const pageLinks = (json) => json.links.filter((l) => l.url.startsWith('/'))

test('the file has exactly the top-level keys and link fields the console reads', async () => {
  const json = await cloudJson({'cloud/a.mdx': {title: 'A', slug: '/a', cloud_tags: 'Get Started'}})
  assert.deepEqual(Object.keys(json), ['tags', 'links'])
  assert.ok(json.tags.includes('Get Started'))
  for (const link of json.links) assert.deepEqual(Object.keys(link).sort(), ['order', 'tags', 'title', 'type', 'url'])
})

test('a page that opts in is an article at its URL, titled by cloud_title or else its title', async () => {
  const json = await cloudJson({
    'cloud/a.mdx': {title: 'Page A', slug: '/get-started', cloud_tags: 'Get Started, Documentation', cloud_order: 3},
    'tutorials/b.mdx': {title: 'Page B', cloud_title: 'Console B', slug: '/b', cloud_tags: 'Develop Applications'},
    'cloud/not-opted-in.mdx': {title: 'Ignored', slug: '/ignored'},
  })
  assert.deepEqual(pageLinks(json), [
    {title: 'Console B', url: '/tutorials/b', tags: ['Develop Applications'], type: 'article', order: 0},
    {title: 'Page A', url: '/cloud/get-started', tags: ['Get Started', 'Documentation'], type: 'article', order: 3},
  ])
})

test('a page with cloud_url_video is a video pointing at the video', async () => {
  const json = await cloudJson({'cloud/v.mdx': {title: 'V', slug: '/v', cloud_tags: 'Videos', cloud_url_video: 'https://example.com/embed/x'}})
  assert.deepEqual(pageLinks(json), [])
  assert.deepEqual(json.links.find((l) => l.title === 'V'), {title: 'V', url: 'https://example.com/embed/x', tags: ['Videos'], type: 'video', order: 0})
})

test('links are sorted by order, including the built-in video entries', async () => {
  const json = await cloudJson({
    'cloud/late.mdx': {title: 'Late', slug: '/late', cloud_tags: 'Documentation', cloud_order: 20},
    'cloud/early.mdx': {title: 'Early', slug: '/early', cloud_tags: 'Documentation', cloud_order: 1},
  })
  const orders = json.links.map((l) => l.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
  assert.ok(json.links.some((l) => l.type === 'video' && l.url.startsWith('https://www.youtube.com/')), 'built-in video entries are present')
})

test('a | in cloud_title splits one page into several entries, pairing tags, order and anchor by position', async () => {
  const json = await cloudJson({
    'cloud/multi.mdx': {
      title: 'Multi',
      slug: '/multi',
      cloud_title: 'First|Second',
      cloud_tags: 'Get Started|Manage Clusters',
      cloud_order: '4|5',
      cloud_anchor: ' intro |',
    },
  })
  assert.deepEqual(pageLinks(json), [
    {title: 'First', url: '/cloud/multi#intro', tags: ['Get Started'], type: 'article', order: 4},
    {title: 'Second', url: '/cloud/multi', tags: ['Manage Clusters'], type: 'article', order: 5},
  ])
})

test('a page whose tags are all outside the allowlist fails the build', async () => {
  await assert.rejects(
    cloudJson({'cloud/bad.mdx': {title: 'Bad', slug: '/bad', cloud_tags: 'Not A Tag'}}),
    /Wrong cloud tag 'Not A Tag' in 'Bad'/,
  )
})

test('a page that opts in without a slug fails the build, since its URL cannot be known', async () => {
  await assert.rejects(cloudJson({'cloud/noslug.mdx': {title: 'X', cloud_tags: 'Documentation'}}), /has cloud_tags but no slug/)
})
