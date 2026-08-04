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
//   - the title <header>: for the migration's synthetic-title pages the swizzled
//     DocItem/Content wraps the page-title <h1> AND the page-level badge row
//     (TitleBadgeRow, e.g. `dedicated: true`) in a direct-child <header>. The
//     golden body fragment has no title area at all, so the whole header is
//     chrome. Title fidelity is checked via frontmatter, not here. (A bare h1
//     outside a header is dropped as a fallback.)
//   - the inline-badge popover: an inline <Badge> renders a `.popover` span
//     (tooltip text + a "Learn more" link) alongside its visible label. The
//     label IS body content (the golden has it), but the popover is Docusaurus-
//     only UI the golden never has -- strip it so only the label is compared.
//   - handled by the Layer-1 strip list (.hash-link, admonition heading label).

const cheerio = require('cheerio')

function extractMain (fullHtml) {
  const $ = cheerio.load(fullHtml)
  let root = $('.theme-doc-markdown').first()
  if (!root.length) root = $('article').first()
  if (!root.length) root = $('main').first()
  if (!root.length) return null // not a recognizable doc page
  root.children('header').first().remove() // drop the title header (badge row + h1)
  root.find('h1').first().remove() // fallback: any remaining page-title h1
  // Inline-badge popover (hashed CSS-module class, e.g. `popover_Tx9d`): drop the
  // supplementary tooltip/"Learn more", keeping the badge's visible label.
  root.find('[class*="popover_"]').remove()
  return root.html()
}

module.exports = { extractMain }
