'use strict'

const path = require('node:path')
const fs = require('node:fs')

const { normalizeUrl } = require('@docusaurus/utils')
const { applyTrailingSlash } = require('@docusaurus/utils-common')

// Emits /llms.txt at build time — the index an LLM or coding agent reads to find
// its way around the docs (llmstxt.org). A curated link list, not content: an H1
// naming the site, a blockquote summary, then one H2 per product whose entries
// are `- [Title](absolute url): description`.
//
// Runs in postBuild rather than contentLoaded because postBuild is the only hook
// that has BOTH halves of the job. `props.plugins` carries every loaded plugin's
// content, so the docs instances' versions, sidebars and per-page metadata are
// all here — and `outDir` holds the rendered HTML that the eventual llms-full.txt
// and per-page .md pass will convert. Building the index here means that pass is
// a second loop in the same hook, not a rewrite.
//
// Nothing is read off disk and nothing is re-parsed: titles, descriptions,
// permalinks and nav order all come from the docs plugin's own loaded content,
// which is the same data the rendered site was built from.

// The plugin's own `name`, which is NOT its package name — a LoadedPlugin
// identifies itself as 'docusaurus-plugin-content-docs'.
const DOCS_PLUGIN_NAME = 'docusaurus-plugin-content-docs'
const OUT_PATH = 'llms.txt'

// Descriptions are Docusaurus's own page description — the `description`
// frontmatter where a page sets one, otherwise the excerpt it puts in the page's
// <meta name="description">. Long enough to choose a page from, capped so the
// index stays scannable.
const MAX_DESCRIPTION = 200

const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim()

function summarise (text) {
  const line = oneLine(text)
  if (line.length <= MAX_DESCRIPTION) return line
  const cut = line.slice(0, MAX_DESCRIPTION)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…'
}

// 'management-center' -> 'Management Center'. Only reached for an instance the
// navbar does not name (see productLabels).
const titleCase = (id) =>
  id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

// Product display names, taken from the navbar so the index calls each product
// what the site calls it and cannot drift from it — `hazelcast` is the URL
// segment and plugin id, but the product is "Platform". A `docSidebar` item
// names its docs instance; tutorials is a plain link (the component is nav-less,
// so it has no sidebar to open), and anything the navbar does not name falls
// back to its own id.
function productLabels (siteConfig) {
  const items = siteConfig.themeConfig?.navbar?.items ?? []
  const labels = new Map()
  items.forEach((item, position) => {
    if (item.type === 'docSidebar' && item.docsPluginId) {
      labels.set(item.docsPluginId, { label: item.label, position })
    }
  })
  return labels
}

// The one version of each component this index covers: whichever Docusaurus
// marks `isLast`. That is exactly the right selector here rather than a
// convenience — src/docsPlugins.ts sets `lastVersion` to the newest RELEASE for
// every component whose main is an unreleased snapshot, so `isLast` excludes
// snapshots for the same reason the sitemap and the cross-version canonical do,
// derived from the same config rather than from a second rule that could drift.
// An unversioned component has one version, and it is that one.
function currentVersion (plugin) {
  const versions = plugin.content?.loadedVersions ?? []
  const version = versions.find((candidate) => candidate.isLast)
  if (!version) {
    throw new Error(`[llms-txt] docs instance '${plugin.options.id}' has no version marked isLast`)
  }
  return version
}

// The URL segment the version is served under, or null where the component is
// unversioned. A versioned instance serves each version one segment below the
// component root (/hazelcast/5.7); an unversioned one serves at the root itself
// (/cloud), which is what distinguishes the two without asking the config.
function versionSegment (plugin, version, baseUrl) {
  const root = normalizeUrl([baseUrl, plugin.options.routeBasePath])
  const prefix = root.endsWith('/') ? root : `${root}/`
  return version.path.startsWith(prefix) ? version.path.slice(prefix.length) : null
}

// Docs are keyed by id because that is what a sidebar item carries. Drafts are
// already absent from `docs` in a production build; unlisted pages are present
// but render noindex, so listing them here would invite exactly the crawl the
// page asks not to have.
function publishedDocs (version) {
  return new Map(
    version.docs.filter((doc) => !doc.draft && !doc.unlisted).map((doc) => [doc.id, doc]),
  )
}

// Flatten a category into its pages, depth-first, in sidebar order. A category
// whose `link` is a doc contributes that page first — it is the category's own
// landing page. A `generated-index` link has no page of its own, and `link`/
// `html` items are not docs, so neither contributes an entry.
function collectCategory (category, byId, seen, out) {
  if (category.link?.type === 'doc') addDoc(category.link.id, byId, seen, out)
  for (const item of category.items) {
    if (item.type === 'category') collectCategory(item, byId, seen, out)
    else if (item.type === 'doc' || item.type === 'ref') addDoc(item.id, byId, seen, out)
  }
}

function addDoc (id, byId, seen, out) {
  if (seen.has(id)) return
  const doc = byId.get(id)
  if (!doc) return
  seen.add(id)
  out.push(doc)
}

// Split the version's sidebars into the shape the index renders: pages that sit
// at the top level of a sidebar, then one group per top-level category (its
// whole subtree flattened), then whatever the sidebars never reached.
//
// That last group is not a leftovers bin to be tidied away: a page unreachable
// from the nav is still published and still worth an agent's time, and an index
// that silently omitted it would be the one place on the site that pretends it
// does not exist. `orphancheck` is what decides whether such a page SHOULD exist;
// this only makes sure the index tells the truth about the ones that do.
function sections (version, byId) {
  const seen = new Set()
  const loose = []
  const groups = []
  for (const sidebar of Object.values(version.sidebars ?? {})) {
    for (const item of sidebar) {
      if (item.type === 'category') {
        const entries = []
        collectCategory(item, byId, seen, entries)
        if (entries.length) groups.push({ label: item.label, entries })
      } else if (item.type === 'doc' || item.type === 'ref') {
        addDoc(item.id, byId, seen, loose)
      }
    }
  }
  const unreachable = [...byId.values()].filter((doc) => !seen.has(doc.id))
  return { loose, groups, unreachable }
}

function entryLine (doc, siteConfig) {
  const url =
    siteConfig.url +
    applyTrailingSlash(doc.permalink, {
      trailingSlash: siteConfig.trailingSlash,
      baseUrl: siteConfig.baseUrl,
    })
  const description = summarise(doc.description)
  return `- [${oneLine(doc.title)}](${url})${description ? `: ${description}` : ''}`
}

function renderProduct (product, siteConfig, lines) {
  const { label, segment, loose, groups, unreachable } = product
  lines.push(`## ${segment ? `${label} ${segment}` : label}`, '')
  for (const doc of loose) lines.push(entryLine(doc, siteConfig))
  if (loose.length) lines.push('')
  for (const group of groups) {
    lines.push(`### ${group.label}`, '')
    for (const doc of group.entries) lines.push(entryLine(doc, siteConfig))
    lines.push('')
  }
  if (unreachable.length) {
    lines.push('### Other pages', '')
    for (const doc of unreachable) lines.push(entryLine(doc, siteConfig))
    lines.push('')
  }
}

function render (products, siteConfig) {
  const lines = [`# ${siteConfig.title}`, '']
  if (siteConfig.tagline) lines.push(`> ${siteConfig.tagline}`, '')
  lines.push(
    'This index covers the current release of each product. Earlier releases stay published ' +
      'under their own version segment, and unreleased snapshot versions are omitted — a page ' +
      'listed here is the one the docs treat as current.',
    '',
  )
  for (const product of products) renderProduct(product, siteConfig, lines)
  return lines.join('\n').replace(/\n+$/, '\n')
}

module.exports = function llmsTxtPlugin () {
  return {
    name: 'llms-txt',

    // postBuild only, like cloud-console-index: this is a published artifact
    // rather than a dev-server route, and it is written from the same build the
    // URLs in it point at. No timestamp, so the output is deterministic.
    async postBuild ({ outDir, siteConfig, plugins }) {
      const labels = productLabels(siteConfig)
      const products = plugins
        .filter((plugin) => plugin.name === DOCS_PLUGIN_NAME)
        .map((plugin, index) => {
          const id = plugin.options.id
          const version = currentVersion(plugin)
          const named = labels.get(id)
          return {
            label: named?.label ?? titleCase(id),
            // Instances the navbar does not name sort after the ones it does,
            // keeping their order in docusaurus.config.ts among themselves.
            order: named?.position ?? labels.size + index,
            segment: versionSegment(plugin, version, siteConfig.baseUrl),
            ...sections(version, publishedDocs(version)),
          }
        })
        .sort((a, b) => a.order - b.order)

      // Every page in the index comes from a docs instance, so no instances
      // means an index of nothing. Fail rather than publish an empty file: a
      // valid-looking llms.txt listing no pages is worse than none at all.
      if (products.length === 0) {
        throw new Error(`[llms-txt] no '${DOCS_PLUGIN_NAME}' instances found — nothing to index`)
      }

      fs.writeFileSync(path.join(outDir, OUT_PATH), render(products, siteConfig), 'utf8')
      const pages = products.reduce(
        (total, p) =>
          total + p.loose.length + p.unreachable.length +
          p.groups.reduce((n, g) => n + g.entries.length, 0),
        0,
      )
      console.log(`[llms-txt] Wrote ${OUT_PATH} (${pages} pages across ${products.length} products)`)
    },
  }
}
