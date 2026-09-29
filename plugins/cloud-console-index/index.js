'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { Globby, parseMarkdownFile, DEFAULT_PARSE_FRONT_MATTER } = require('@docusaurus/utils')

// Emits /api/cloud.json at build time: the index the Cloud console's in-product help nav fetches.
// The { tags, links } shape is a contract with the console; don't change it.
// Source: cloud_* frontmatter on pages (a page opts in with cloud_tags). A `|` in
// cloud_title/cloud_tags/cloud_order/cloud_anchor/cloud_url_video splits one page into several entries.

// Content trees scanned for cloud_* frontmatter, with their route bases. URL = base + `slug`, so
// opted-in pages need a slug and their docs instance must be unversioned.
// Keep in sync with path/routeBasePath in docusaurus.config.ts.
const DOC_SOURCES = [
  { dir: 'cloud', base: '/cloud' },
  { dir: 'tutorials', base: '/tutorials' },
]
const OUT_PATH = 'api/cloud.json'

// Allowlist; a page tag outside it fails the build.
const TAGS = [
  'Favorites', 'Videos', 'Get Started', 'Whitepapers', 'Use cases',
  'Case studies', 'Documentation', 'Develop Applications',
  'Organizations and Accounts', 'Manage Accounts', 'Manage Organizations',
  'Manage Clusters',
]

// Entries with no doc page of their own.
const DATA = [
  { title: 'What is a client?', url: 'https://www.youtube.com/embed/lkQEAdgxvbE', type: 'video', order: 8, tags: 'Videos, Get Started' },
  { title: 'What is the Hazelcast Platform?', url: 'https://www.youtube.com/embed/UpIgHzKbMp0', type: 'video', order: 9, tags: 'Videos, Get Started' },
]

// Reads cloud_* frontmatter of opted-in pages; the URL is rebuilt from the slug.
async function readCloudDocs (siteDir) {
  const docs = []
  for (const { dir, base } of DOC_SOURCES) {
    const docsDir = path.join(siteDir, dir)
    const files = await Globby('**/*.{md,mdx}', { cwd: docsDir })
    for (const rel of files) {
      const filePath = path.join(docsDir, rel)
      const fileContent = fs.readFileSync(filePath, 'utf8')
      const { frontMatter } = await parseMarkdownFile({
        filePath,
        fileContent,
        parseFrontMatter: DEFAULT_PARSE_FRONT_MATTER,
      })
      if (!frontMatter || frontMatter.cloud_tags == null) continue
      if (!frontMatter.slug) {
        throw new Error(`[cloud-console-index] ${dir}/${rel} has cloud_tags but no slug — cannot resolve its URL`)
      }
      const url = (base + frontMatter.slug).replace(/\/{2,}/g, '/')
      docs.push({ frontMatter, permalink: url, title: frontMatter.title })
    }
  }
  return docs
}

// Builds the links array from DATA plus pages' cloud_* frontmatter, sorted by order.
function buildLinks (docs) {
  const links = []
  const addEntity = ({ title, url, tags, type, order }) => {
    const arr = String(tags).split(',').map((c) => c.trim())
    if (TAGS.length && !arr.some((name) => TAGS.includes(name))) {
      throw new Error(`[cloud-console-index] Wrong cloud tag '${arr.join(', ')}' in '${title}'`)
    }
    links.push({
      title: title && String(title).trim(),
      url: url && String(url).trim(),
      tags: arr,
      type: type && String(type).trim(),
      order: order ? parseInt(order, 10) : 0,
    })
  }
  for (const item of DATA) addEntity(item)
  for (const doc of docs) {
    const fm = doc.frontMatter || {}
    const tags = fm.cloud_tags
    if (!tags) continue
    const urlVideo = fm.cloud_url_video
    const type = urlVideo ? 'video' : 'article'
    const title = fm.cloud_title != null ? fm.cloud_title : doc.title
    if (title != null && String(title).includes('|')) {
      String(title).split('|').forEach((titleMulti, i) => {
        const tagsMulti = String(fm.cloud_tags).split('|')[i]
        const orderMulti = fm.cloud_order ? String(fm.cloud_order).split('|')[i] : ''
        const anchorMulti = fm.cloud_anchor ? String(fm.cloud_anchor).split('|')[i] : ''
        const urlMulti = fm.cloud_url_video ? String(fm.cloud_url_video).split('|')[i] : doc.permalink
        addEntity({
          title: titleMulti,
          url: urlMulti + (anchorMulti && anchorMulti.trim() ? `#${anchorMulti.trim()}` : ''),
          tags: tagsMulti,
          type,
          order: orderMulti,
        })
      })
    } else {
      addEntity({ title, url: urlVideo != null ? urlVideo : doc.permalink, tags, type, order: fm.cloud_order })
    }
  }
  links.sort((a, b) => a.order - b.order)
  return links
}

module.exports = function cloudConsoleIndexPlugin (context) {
  const { siteDir } = context
  return {
    name: 'cloud-console-index',
    // postBuild: this is a published artifact, not a dev-server route.
    // No timestamp, so output is deterministic.
    async postBuild ({ outDir }) {
      const docs = await readCloudDocs(siteDir)
      const links = buildLinks(docs)
      const file = path.join(outDir, OUT_PATH)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ tags: TAGS, links }))
    },
  }
}
