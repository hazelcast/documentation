'use strict'

const path = require('node:path')
const fs = require('node:fs')

const { normalizeUrl } = require('@docusaurus/utils')
const { applyTrailingSlash } = require('@docusaurus/utils-common')

// Emits /llms.txt at build time (llmstxt.org): an H1, a blockquote summary, then one H2 per product listing
// `- [Title](absolute url): description` entries, all taken from the docs plugin's loaded content.
// Runs in postBuild because it needs props.plugins (every plugin's loaded content) and outDir together.

// A LoadedPlugin's name, not its package name.
const DOCS_PLUGIN_NAME = 'docusaurus-plugin-content-docs'
const OUT_PATH = 'llms.txt'

// Description is the page's `description` frontmatter or else its excerpt; capped to stay scannable.
const MAX_DESCRIPTION = 200

const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim()

function summarise (text) {
  const line = oneLine(text)
  if (line.length <= MAX_DESCRIPTION) return line
  const cut = line.slice(0, MAX_DESCRIPTION)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…'
}

// 'management-center' -> 'Management Center'; only used for instances the navbar doesn't name.
const titleCase = (id) =>
  id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

// Product display names from the navbar, so the index can't drift from the site (`hazelcast` is the URL
// segment, the product is "Platform"). Only `docSidebar` items name an instance; others fall back to their id.
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

// The version indexed per component: `isLast`, which src/docsPlugins.ts sets to the newest release, so
// snapshots are excluded as in the sitemap and canonical. An unversioned component has one version.
function currentVersion (plugin) {
  const versions = plugin.content?.loadedVersions ?? []
  const version = versions.find((candidate) => candidate.isLast)
  if (!version) {
    throw new Error(`[llms-txt] docs instance '${plugin.options.id}' has no version marked isLast`)
  }
  return version
}

// URL segment the version is served under, or null if unversioned (versioned instances serve one segment
// below the component root, unversioned ones at the root).
function versionSegment (plugin, version, baseUrl) {
  const root = normalizeUrl([baseUrl, plugin.options.routeBasePath])
  const prefix = root.endsWith('/') ? root : `${root}/`
  return version.path.startsWith(prefix) ? version.path.slice(prefix.length) : null
}

// Keyed by id, as sidebar items are. Unlisted pages are omitted: they render noindex.
function publishedDocs (version) {
  return new Map(
    version.docs.filter((doc) => !doc.draft && !doc.unlisted).map((doc) => [doc.id, doc]),
  )
}

// Flattens a category depth-first in sidebar order; a doc `link` is its landing page and comes first.
// generated-index links and link/html items contribute nothing.
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

// Splits sidebars into top-level pages, one group per top-level category, then pages the sidebars never reach.
// That last group stays: an unreachable page is still published, so the index must list it.
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

    // postBuild only: a published artifact written from the same build its URLs point at. No timestamp, so output is deterministic.
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
            // Instances the navbar doesn't name sort last, in config order.
            order: named?.position ?? labels.size + index,
            segment: versionSegment(plugin, version, siteConfig.baseUrl),
            ...sections(version, publishedDocs(version)),
          }
        })
        .sort((a, b) => a.order - b.order)

      // Fail rather than publish an empty llms.txt.
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
