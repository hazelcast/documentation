'use strict'

// Layer 2: structural inventory. Per-page counts of the structural features a
// faithful conversion must preserve, so we catch regressions that Layer 1's
// text normalization hides (admonition flattened to a paragraph, code block
// rendered as plain text, table linearized, list collapsed).
//
// The golden side is Asciidoctor HTML; the converted side is Docusaurus HTML
// with entirely different classes. So the inventory counts SEMANTICS, not
// markup: headings, code blocks, admonitions (by type), content tables, images,
// links, list items, tab sets. Shared semantic HTML5 tags (h1-h6, img, li, pre,
// a) are counted the same on both sides; the renderer-specific bits
// (admonitions, content-vs-layout tables, tabs) come from a PROFILE so the same
// extractor serves both. Golden profile is defined + validated now; the
// Docusaurus profile is filled in when the converter produces pages.

const cheerio = require('cheerio')

const ADMONITION_TYPES = ['note', 'tip', 'warning', 'caution', 'important']

// Asciidoctor (Antora golden) profile.
const ASCIIDOC_PROFILE = {
  // <li> covers ulist/olist; description lists use <dt>. Count both as items.
  listItemSelector: 'li, .dlist dt',
  // Content tables only. Asciidoctor gives them class "tableblock"; admonitions
  // and some layouts also emit bare <table> for icon/layout, which must NOT
  // count as content tables.
  contentTableSelector: 'table.tableblock',
  // Admonition block, classified by its type class.
  admonitionSelector: '.admonitionblock',
  admonitionType: ($, el) => ADMONITION_TYPES.find((t) => $(el).hasClass(t)) || 'unknown',
  // tabs-block extension output: .tabset is the set container, .tab-pane each
  // individual tab. (The .ulist.tabs is just the label list -- do NOT key off
  // it.) Count both: sets, and total tabs across sets.
  tabSetSelector: '.tabset',
  tabItemSelector: '.tab-pane',
}

// Docusaurus profile -- STUB. Filled in against real converted output (the
// deferred extract-main seam). Kept here so the shape is one place.
const DOCUSAURUS_PROFILE = {
  listItemSelector: 'li, dl dt',
  contentTableSelector: 'table', // markdown tables; refine if theme adds others
  admonitionSelector: '.theme-admonition, .admonition',
  admonitionType: ($, el) => {
    const cls = ($(el).attr('class') || '')
    // Prefer the authoritative `theme-admonition-<type>` class. Docusaurus also
    // adds a colour-alias class (`:::caution` styles as `alert--warning`), so a
    // bare `cls.includes(type)` would mis-read a caution as a warning.
    const m = cls.match(/theme-admonition-([a-z]+)/)
    if (m && ADMONITION_TYPES.includes(m[1])) return m[1]
    return ADMONITION_TYPES.find((t) => cls.includes(t)) || 'unknown'
  },
  tabSetSelector: '.tabs-container',
  tabItemSelector: '[role="tabpanel"]',
}

function inventory (html, profile = ASCIIDOC_PROFILE, { fragment = true } = {}) {
  const $ = cheerio.load(html, null, !fragment)

  const headings = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 }
  for (let l = 1; l <= 6; l++) headings['h' + l] = $('h' + l).length

  const admonitions = Object.fromEntries(ADMONITION_TYPES.map((t) => [t, 0]))
  admonitions.unknown = 0
  $(profile.admonitionSelector).each((_, el) => {
    admonitions[profile.admonitionType($, el)]++
  })

  return {
    headings,
    headingsTotal: Object.values(headings).reduce((a, b) => a + b, 0),
    // Standalone code blocks only: a `<pre>` inside a table cell (golden's
    // `[cols="l"]` literal cell) is cell content compared via the table-row
    // mechanism in Layer 1, not a block. Excluding it keeps the count invariant
    // whether such a cell renders as a block <pre> or as inline `code`.
    codeBlocks: $('pre').filter((_, el) => $(el).closest('td, th').length === 0).length,
    admonitions,
    admonitionsTotal: Object.values(admonitions).reduce((a, b) => a + b, 0),
    tables: $(profile.contentTableSelector).length,
    images: $('img').length,
    links: $('a[href]').length,
    listItems: $(profile.listItemSelector).length,
    tabSets: $(profile.tabSetSelector).length,
    tabItems: $(profile.tabItemSelector).length,
  }
}

module.exports = { inventory, ASCIIDOC_PROFILE, DOCUSAURUS_PROFILE, ADMONITION_TYPES }
