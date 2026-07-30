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
// Two things inside it still need dropping to align with the golden fragment:
//   - the page-title <h1>: golden body fragments never contain it (Antora puts
//     the title in chrome). Title fidelity is checked via frontmatter, not here.
//   - handled by the Layer-1 strip list (.hash-link, admonition heading label).

const cheerio = require('cheerio')

function extractMain (fullHtml) {
  const $ = cheerio.load(fullHtml)
  let root = $('.theme-doc-markdown').first()
  if (!root.length) root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) return null // not a recognizable doc page
  root.find('h1').first().remove() // drop the page-title h1
  return root.html()
}

module.exports = { extractMain }
