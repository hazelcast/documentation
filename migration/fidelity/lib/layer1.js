'use strict'

// Layer 1: normalized main-content text diff -- the primary fidelity gate, and
// the code that carries the contractual "published content must not change"
// guarantee. Reduces a main-content HTML fragment to an ordered list of
// SEGMENTS (prose or code) so a diff localizes to a block, not one giant blob.
//
// Normalization is deliberately only the fidelity-SAFE kind (see
// [[docusaurus-migration-tooling]] prose-unwrap + final-newline decisions):
//   - prose: collapse all whitespace runs to one space, trim, and fold
//     typographic glyphs Asciidoctor introduces (curly quotes, en/em dashes,
//     ellipsis, nbsp) back to ASCII so they do not read as content changes.
//     Intra-paragraph line breaks are meaningless in both AsciiDoc and MD, so
//     collapsing them is byte-safe on the rendered output.
//   - code: preserved verbatim (whitespace is significant), only trailing
//     whitespace per line and trailing blank lines dropped.
//
// RENDERER-NOISE CALIBRATION (deferred to first real converted output): things
// that differ by renderer but are not content -- admonition TITLE text
// ("NOTE"), auto-numbered table captions ("Table 1."), "Edit this page" etc. --
// are stripped via the profile's stripSelectors / stripPatterns. The golden
// (Asciidoctor) profile needs almost none of this (its admonition label is an
// icon, not text); the Docusaurus profile will grow as pages appear.

const cheerio = require('cheerio')

const BLOCK = new Set([
  'p', 'li', 'dt', 'dd', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'caption', 'blockquote', 'div', 'ul', 'ol', 'table', 'thead', 'tbody',
  'section', 'article', 'header', 'figure', 'figcaption', 'details', 'summary',
])
const CODE_PLACEHOLDER = /^␞(\d+)␞$/
const TABLE_PLACEHOLDER = /^␟(\d+)␟$/

const GOLDEN_STRIP = ['a.anchor'] // the ¶ self-link Asciidoctor prepends to headings
// Docusaurus chrome that leaks text a golden fragment does not have: the
// heading hash-link (zero-width text), the admonition ICON, and the code
// block's header bar (src/theme/CodeBlock/Layout) -- a language label and the
// copy/word-wrap buttons, site chrome we added, never page content. The block
// TITLE bar is deliberately not stripped: Asciidoctor renders a block title too,
// so it is content and must be compared.
const DOCUSAURUS_STRIP = ['.hash-link', '[class*="admonitionIcon"]', '[class*="codeBlockHeader"]']

// An admonition's heading text is chrome ONLY when it is the bare type word --
// Docusaurus renders `:::note` as the heading "note" while Asciidoctor renders
// that label as an icon with no text. A heading carrying anything else is a
// CUSTOM TITLE (`:::warning[Heap memory limits]`), which the golden also renders
// (as `<div class="title">`), so it is content and must be compared. Stripping
// the whole heading unconditionally -- as this did until 2026-08-17 -- reported
// every custom-titled admonition as missing text on the converted side.
const ADMONITION_LABELS = new Set(['note', 'tip', 'info', 'warning', 'danger', 'caution', 'important', 'secondary'])
const DOCUSAURUS_STRIP_IF = [
  { selector: '[class*="admonitionHeading"]', drop: (text) => ADMONITION_LABELS.has(text.trim().toLowerCase()) },
]

// Content tables are compared row-by-row (see canonicalize). The two renderers
// mark up content tables differently: Asciidoctor tags them `.tableblock`;
// Docusaurus (Markdown/GFM) emits a plain <table>, and a raw-HTML table we emit
// keeps its `.tableblock` class -- so `table` covers both on the converted side.
// Admonition/layout tables (bare <table> inside .admonitionblock on the golden
// side) are deliberately NOT matched here; they fall through to the walk as
// plain text.
const GOLDEN_TABLE = 'table.tableblock'
const DOCUSAURUS_TABLE = 'table'

function normalizeProse (s) {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCode (s) {
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}

// Text of an element with a space inserted at every block boundary. A content
// cell may hold multiple blocks (paragraphs, a list, an admonition); a plain
// .text() concatenates them with NO separator. Asciidoctor's pretty-printed
// HTML happens to carry whitespace between blocks, but Docusaurus minifies it
// away -- so the two would differ by nothing but a missing space. Inserting the
// boundary space on BOTH sides (then collapsing in normalizeProse) keeps the
// compare symmetric and independent of each renderer's whitespace.
function blockText ($, el) {
  const parts = []
  ;(function walk (node) {
    for (const c of node.children || []) {
      if (c.type === 'text') parts.push(c.data)
      else if (c.type === 'tag') {
        if (BLOCK.has(c.name)) parts.push(' ')
        walk(c)
        if (BLOCK.has(c.name)) parts.push(' ')
      }
    }
  })(el)
  return parts.join('')
}

// -> [{ kind: 'text'|'code', text }]
function canonicalize (html, { stripSelectors = GOLDEN_STRIP, stripIf = [], tableSelector = null } = {}, { fragment = true } = {}) {
  const $ = cheerio.load(html, null, !fragment)
  for (const sel of stripSelectors) $(sel).remove()
  // Text-dependent strips: chrome that is only chrome for certain content (see
  // DOCUSAURUS_STRIP_IF).
  for (const { selector, drop } of stripIf) {
    $(selector).each((_, el) => { if (drop($(el).text())) $(el).remove() })
  }

  // Pull code out first, leaving an isolated placeholder line in the text flow.
  // Docusaurus (Prism) renders each code line as a `.token-line` span with NO
  // newline text node between them, so a plain .text() concatenates all lines
  // into one -- whereas Asciidoctor's <pre> carries real newlines. Rebuild line
  // breaks from `.token-line` when present so code compares faithfully; fall
  // back to .text() for the Asciidoctor golden side.
  const codes = []
  $('pre').each((_, el) => {
    const lines = $(el).find('.token-line')
    const text = lines.length
      ? lines.map((_, l) => $(l).text()).get().join('\n')
      : $(el).text()
    codes.push(text)
    $(el).replaceWith(`\n␞${codes.length - 1}␞\n`)
  })

  // Pull CONTENT tables out and represent each as one line per row (cells joined
  // by " │ "). Compared row-by-row, this is independent of how each renderer
  // wraps cell content -- Asciidoctor wraps every cell in <p>/<div> blocks and
  // pretty-prints a newline between cells, Docusaurus renders them inline -- so
  // a faithful table matches even though the two HTMLs are structured nothing
  // alike. Only content tables (tableSelector); admonition/layout tables are
  // left in the flow as plain text.
  const tables = []
  if (tableSelector) {
    $(tableSelector).each((_, el) => {
      const rows = []
      // Direct rows only: descending into a cell's nested admonition/layout
      // table would mis-read its <tr> as a spurious content row. Cell text uses
      // blockText so multi-block cells keep a separator between their blocks.
      $(el).find('> thead > tr, > tbody > tr, > tfoot > tr, > tr').each((_, tr) => {
        const cells = $(tr).children('td,th').map((_, c) => normalizeProse(blockText($, c))).get()
        if (cells.length) rows.push('│ ' + cells.join(' │ '))
      })
      tables.push(rows)
      $(el).replaceWith(`\n␟${tables.length - 1}␟\n`)
    })
  }

  // Walk: block elements delimit segments (a newline); text nodes contribute
  // whitespace-COLLAPSED prose. Collapsing here is the fix for source-wrapped
  // paragraphs -- Asciidoctor keeps the author's line breaks inside <p> text,
  // which both AsciiDoc and Markdown render as a single space, so they must not
  // split a paragraph into separate segments. After this, the only newlines in
  // the stream come from block boundaries and the code/table placeholders.
  const parts = []
  ;(function walk (node) {
    for (const c of node.children || []) {
      if (c.type === 'text') parts.push(c.data.replace(/\s+/g, ' '))
      else if (c.type === 'tag') {
        const isBlock = BLOCK.has(c.name)
        if (isBlock) parts.push('\n')
        walk(c)
        if (isBlock) parts.push('\n')
      }
    }
  })($.root()[0])

  const segments = []
  for (const rawLine of parts.join('').split('\n')) {
    const piece = rawLine.trim()
    if (piece === '') continue
    let m
    if ((m = piece.match(CODE_PLACEHOLDER))) {
      const code = normalizeCode(codes[Number(m[1])])
      if (code !== '') segments.push({ kind: 'code', text: code })
      continue
    }
    if ((m = piece.match(TABLE_PLACEHOLDER))) {
      for (const row of tables[Number(m[1])]) {
        // A cell's code was pulled out as a `␞N␞` placeholder before the table
        // was captured. Resolve it back to the code text so a cell compares by
        // its content regardless of representation: golden's `.literal` <pre>,
        // an HTML-table fenced block, and a GFM `code` cell all reduce equal.
        const resolved = row.replace(/␞(\d+)␞/g, (_, n) => codes[Number(n)] || '')
        const text = normalizeProse(resolved)
        if (text !== '') segments.push({ kind: 'text', text })
      }
      continue
    }
    const text = normalizeProse(piece)
    if (text !== '') segments.push({ kind: 'text', text })
  }
  return segments
}

// Comparable key for one segment.
const segKey = (s) => (s.kind === 'code' ? 'C ' : 'T ') + s.text

// LCS line diff over segments -> ordered ops. Equal runs are dropped from the
// report; only '+'/'-' remain, so an unchanged page yields [].
//
// Common prefix/suffix are trimmed before the O(n*m) LCS, so a faithful
// conversion (which differs in only a few segments) runs LCS on a tiny middle
// instead of allocating an n*m matrix -- critical for the giant api-ref pages
// (8000+ segments; a full matrix would be ~280MB).
function diffSegments (golden, converted) {
  const ga = golden.map(segKey)
  const gb = converted.map(segKey)
  let lo = 0
  let hiA = ga.length
  let hiB = gb.length
  while (lo < hiA && lo < hiB && ga[lo] === gb[lo]) lo++
  while (hiA > lo && hiB > lo && ga[hiA - 1] === gb[hiB - 1]) { hiA--; hiB-- }
  const a = ga.slice(lo, hiA)
  const b = gb.slice(lo, hiB)
  const gMid = golden.slice(lo, hiA)
  const cMid = converted.slice(lo, hiB)
  const n = a.length
  const mLen = b.length
  if (n === 0 && mLen === 0) return []
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(mLen + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = mLen - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < mLen) {
    if (a[i] === b[j]) { i++; j++ } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: '-', ...gMid[i] }); i++
    } else { ops.push({ op: '+', ...cMid[j] }); j++ }
  }
  while (i < n) ops.push({ op: '-', ...gMid[i++] })
  while (j < mLen) ops.push({ op: '+', ...cMid[j++] })
  return ops
}

module.exports = {
  canonicalize, diffSegments, normalizeProse, normalizeCode, segKey,
  GOLDEN_STRIP, DOCUSAURUS_STRIP, DOCUSAURUS_STRIP_IF, ADMONITION_LABELS,
  GOLDEN_TABLE, DOCUSAURUS_TABLE,
}
