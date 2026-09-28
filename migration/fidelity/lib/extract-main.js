'use strict'

// The one deferred seam: pull the main-content fragment out of a FULL Docusaurus
// static page so it is comparable to a golden Antora body fragment. Calibrated
// against the scaffold build (`npm run build` at the repo root); refine when the
// converter produces real pages.
//
// Docusaurus wraps doc content in `.theme-doc-markdown` (inside <article> inside
// <main>). Crucially, the page chrome that must NOT be compared -- breadcrumbs,
// "Edit this page", tags, prev/next pagination, the TOC -- all live OUTSIDE
// `.theme-doc-markdown` (in sibling `.theme-doc-*` blocks), so selecting that
// container excludes them for free.
//
// Things inside it still need dropping to align with the golden fragment:
//   - the page-title <h1>: the swizzled DocItem/Content renders it (for
//     synthetic-title pages, wrapped in a <header>). The golden body fragment
//     has no title area, so extractPage returns the title's text separately
//     for Layer 2 to compare against the manifest's Antora doctitle.
//   - the inline-badge popover: an inline <Badge> renders a `.popover` span
//     (tooltip text + a "Learn more" link) alongside its visible label. The
//     label IS body content (the golden has it), but the popover is Docusaurus-
//     only UI the golden never has -- strip it so only the label is compared.
//   - handled by the Layer-1 strip list (.hash-link, admonition heading label).
//
// The page-level badge row (TitleBadgeRow, e.g. `dedicated: true`) renders
// OUTSIDE `.theme-doc-markdown` (a sibling before it, like DocVersionBadge), so
// selecting that container already excludes it -- no explicit drop needed.

const cheerio = require('cheerio')

function extractPage (fullHtml) {
  const $ = cheerio.load(fullHtml)
  let root = $('.theme-doc-markdown').first()
  if (!root.length) root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) return { fragment: null, title: null } // not a recognizable doc page
  // Inline-badge popover (hashed CSS-module class, e.g. `popover_Tx9d`): drop the
  // supplementary tooltip/"Learn more", keeping the badge's visible label.
  root.find('[class*="popover_"]').remove()
  const h1 = root.find('h1').first()
  const title = h1.length ? h1.text() : null
  h1.remove()
  return { fragment: root.html(), title }
}

const extractMain = (fullHtml) => extractPage(fullHtml).fragment

module.exports = { extractMain, extractPage }
