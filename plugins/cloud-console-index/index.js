'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { Globby, parseMarkdownFile, DEFAULT_PARSE_FRONT_MATTER } = require('@docusaurus/utils')

// Emits /api/cloud.json at build time — the console index the Hazelcast Cloud
// console's in-product help nav fetches. This is the permanent replacement for
// the Antora `api-json.js` extension (hazelcast-docs-tools): same shape, same
// algorithm, but sourced from Docusaurus content instead of the Antora catalog.
//
// Source of truth = cloud_* frontmatter on the cloud docs (seeded from the old
// cloud-* page header attributes during migration, maintained per-page there­
// after). A page opts in with `cloud_tags`; the rest refine its entry. A `|` in
// cloud_title/cloud_tags/cloud_order/cloud_anchor/cloud_url_video splits ONE page
// into MULTIPLE entries. Because the data lives in new-docs (not the migration
// tooling), this survives deletion of migration/.
//
// The tag allowlist doubles as build-time validation (a page tag outside it
// fails the build, exactly as upstream). `data` holds the entries with no doc
// page of their own — the two hardcoded videos.
//
// Mirrors hazelcast-docs/antora-playbook.yml (the api-json.js config block).

// The content trees scanned for cloud_* frontmatter, and the route base each is
// served under. A page's URL = its source's base + its `slug` frontmatter, so
// every page that opts in needs an explicit slug; both instances here are
// unversioned, which is what makes that one-line reconstruction sound.
//
// `tutorials` is in the list because a tutorial can be a console entry too: one
// is (the MongoDB write-through cache, a Favorite). It used to be hardcoded in
// DATA while tutorials was still unmigrated; now that the page is here and
// carries its own cloud_tags, this is what reads it. Match each entry to its
// content-docs instance in docusaurus.config.ts (path/routeBasePath).
const DOC_SOURCES = [
  { dir: 'cloud', base: '/cloud' },
  { dir: 'tutorials', base: '/tutorials' },
]
const OUT_PATH = 'api/cloud.json'

const TAGS = [
  'Favorites', 'Videos', 'Get Started', 'Whitepapers', 'Use cases',
  'Case studies', 'Documentation', 'Develop Applications',
  'Organizations and Accounts', 'Manage Accounts', 'Manage Organizations',
  'Manage Clusters',
]

const DATA = [
  { title: 'What is a client?', url: 'https://www.youtube.com/embed/lkQEAdgxvbE', type: 'video', order: 8, tags: 'Videos, Get Started' },
  { title: 'What is the Hazelcast Platform?', url: 'https://www.youtube.com/embed/UpIgHzKbMp0', type: 'video', order: 9, tags: 'Videos, Get Started' },
]

// Read the frontmatter of every page that opts in, across DOC_SOURCES, returning
// {frontMatter, permalink, title} for each. Self-contained (no dependency on
// content-docs internals): the URL is reconstructed from the page's slug, which
// the migration guarantees on every page carrying cloud_tags. Uses Docusaurus's
// own frontmatter parser for consistency.
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

// Faithful port of api-json.js: build the links array from the docs' cloud_*
// frontmatter, prepending the hardcoded `data` entries, then sort by order.
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
  // Hardcoded extras first, then pages (final sort is stable; orders are unique).
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
    // Emit the file into the build output (served at /api/cloud.json). postBuild
    // runs only for `docusaurus build`, matching the Antora extension's
    // beforePublish — this is a published artifact, not a dev-server route.
    // No timestamp: deterministic, matches production.
    async postBuild ({ outDir }) {
      const docs = await readCloudDocs(siteDir)
      const links = buildLinks(docs)
      const file = path.join(outDir, OUT_PATH)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ tags: TAGS, links }))
    },
  }
}
