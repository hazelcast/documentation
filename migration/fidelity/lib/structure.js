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
// The converter's own "is this a real destination?" predicate, shared rather than
// restated so the comparator and the conversion cannot drift about it (see the
// `links` count below).
const { isPlaceholderUrl } = require('../../converter/lib/mdx')

const ADMONITION_TYPES = ['note', 'tip', 'warning', 'caution', 'important']

// Bumped whenever inventory() changes what it extracts. The golden inventory is
// CACHED to disk keyed by the source pin (see inventory-index.js), which cannot
// notice that this file changed -- so without this a new field would compare an
// old cache's `undefined` against a freshly extracted value on every page.
const INVENTORY_VERSION = 4 // 4: `links` excludes placeholder-URL anchors

// An image's identity for comparison purposes: its file name. Both sides lose
// the directory anyway -- Docusaurus flattens every imported asset into
// /assets/images/ -- and there are no duplicate image basenames across the
// module image directories of any source repo, so the name identifies the file.
const imageBasename = (src) => (src || '').split(/[?#]/)[0].split('/').pop()

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
  imageName: imageBasename,
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
  // Docusaurus content-hashes an imported asset to `<name>-<32 hex>.<ext>` --
  // EXCEPT one under ~10KB, which webpack inlines as a base64 `data:` URI,
  // erasing the file name from the built HTML entirely. `null` means "this
  // position carries no comparable name" (see compareInventory), which is 50 of
  // the 2,771 image references in the built site -- 1.8%, all small icons. The
  // `images` COUNT still covers those; only their identity is unverifiable.
  imageName: (src) => (/^data:/i.test(src || '')
    ? null
    : imageBasename(src).replace(/-[0-9a-f]{32}(\.[^.]+)$/i, '$1')),
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

  // Built with .each rather than .map().get(): cheerio's map DROPS null entries,
  // which would silently shift every position after an inlined image and make
  // the comparison misalign instead of skip.
  const imageNames = []
  $('img').each((_, el) => { imageNames.push(profile.imageName($(el).attr('src'))) })

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
    // WHICH images, in document order -- not just how many. A count alone
    // cannot see a page pointing at the wrong file, which is the whole failure
    // mode of computing image placement (a swapped path still resolves, so
    // `onBrokenMarkdownImages: 'throw'` stays silent too).
    imageNames,
    // Navigable links only. Asciidoctor auto-links a bare `http://…` URL even
    // inside backticks, so a monospaced PLACEHOLDER pseudo-URL like
    // `http://<mc-ip-address>:8080` renders as `<code><a class="bare">…</a></code>`
    // in the golden. That href has literal angle brackets, so it can never be a
    // valid navigable link — Docusaurus rejects it at compile time and the
    // converter (correctly) drops the anchor, keeping the code. Excluding these
    // `<>`-href anchors from the count on BOTH sides removes a false positive
    // without weakening the check for real links.
    //
    // `isPlaceholderUrl` is the SAME judgement one step further out, and the
    // converter has already taken that step: an address the reader types or opens
    // on their own machine (loopback, `.local`, the RFC 2606 example domains) is
    // not a destination either, so it is normalised to inline code with no link —
    // whether or not it happens to be a syntactically valid URL. The exclusion
    // here had not followed, which is why four pages x four versions reported a
    // links deficit that was entirely `http://localhost:8443/swagger-ui/index.html`
    // and `http://localhost:8080`: a comparator blind spot, not a conversion gap.
    // Applied through the converter's own predicate so the two cannot disagree
    // again, and symmetric by construction — one inventory serves both sides, and
    // our side has no such anchors to drop. It replaces 12 accept-list entries
    // (3 MC pages x 4 versions) that had recorded this very reasoning one page at
    // a time; those carried an UPSTREAM REPORT note — the sources should write
    // `` `\http://…` `` so Asciidoctor stops autolinking them — which the
    // normalisation makes cosmetic rather than a fidelity matter.
    links: $('a[href]').filter((_, el) => {
      const href = $(el).attr('href') || ''
      return !/[<>]/.test(href) && !isPlaceholderUrl(href)
    }).length,
    listItems: $(profile.listItemSelector).length,
    tabSets: $(profile.tabSetSelector).length,
    tabItems: $(profile.tabItemSelector).length,
  }
}

module.exports = { inventory, ASCIIDOC_PROFILE, DOCUSAURUS_PROFILE, ADMONITION_TYPES, INVENTORY_VERSION }
