'use strict'

// The HTML->MDX core. Input is one Asciidoctor "embedded" HTML fragment (a
// golden page body, no <html>/<head>, no doctitle <h1>); output is the MDX body
// for the matching Docusaurus page. Asciidoctor's HTML is highly regular and
// class-driven, so we dispatch on element class/tag rather than trying to be a
// general HTML->Markdown engine.
//
// Two serialization targets live here:
//   - Markdown/MDX for the common blocks (paragraphs, sections, lists,
//     admonitions, code, images, tabs) -- clean, maintainable source.
//   - JSX-safe raw HTML (serializeJsx) for the cases Markdown cannot hold:
//     complex table cells (block content inside a cell) and description lists.
//
// Faithfulness is defined by the fidelity harness (Layer 1 text / Layer 2
// structure / Layer 3 links), not by byte-identical HTML, so we optimise for
// "renders back to the same text + structure + working links".

const cheerio = require('cheerio')
const GithubSlugger = require('github-slugger')
const { mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode } = require('./mdx')
const { resolveHref } = require('./links')

const ADMONITION_TYPES = ['note', 'tip', 'warning', 'caution', 'important']
const VOID_ELEMENTS = new Set(['img', 'br', 'hr', 'col', 'input', 'source', 'area', 'wbr'])
// HTML attribute -> JSX prop name for the handful that differ and that we keep.
const JSX_ATTR_MAP = { class: 'className', colspan: 'colSpan', rowspan: 'rowSpan', for: 'htmlFor', tabindex: 'tabIndex' }
// Attributes to keep when serializing raw HTML to JSX (everything else,
// notably presentational style/width/valign/align, is dropped).
const JSX_KEEP = new Set(['id', 'href', 'src', 'alt', 'title', 'target', 'rel', 'scope', 'colspan', 'rowspan', 'class', 'role'])

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// convert(html, ctx) -> { body, imports }
//   ctx: { pageUrl }
function convertBody (html, ctx) {
  const $ = cheerio.load(html, null, false)
  // A per-page slugger mirrors how Docusaurus derives heading ids, so we can
  // detect (and drop) the explicit id where it would match the auto-generated
  // one. It is stateful across the page (duplicate headings get -1, -2 ...), so
  // it must see EVERY heading in document order -- see heading().
  const state = { imports: new Set(), pageUrl: ctx.pageUrl, slugger: new GithubSlugger() }
  const body = convertChildren($, $.root()[0], state, 0)
  return { body: body.trim(), imports: state.imports }
}

// ---------------------------------------------------------------------------
// Block level
// ---------------------------------------------------------------------------

function convertChildren ($, parent, st, depth) {
  const out = []
  for (const node of parent.children || []) {
    if (node.type === 'text') {
      // Stray text between block wrappers is whitespace in Asciidoctor output;
      // real text always lives inside a <p>. Ignore non-whitespace defensively
      // only if it carries content.
      const t = node.data.replace(/\s+/g, ' ').trim()
      if (t) out.push(mdEscape(t))
      continue
    }
    if (node.type !== 'tag') continue
    const block = convertBlock($, node, st, depth)
    if (block && block.trim()) out.push(block.trim())
  }
  return out.join('\n\n')
}

function classes (node) {
  return (node.attribs && node.attribs.class ? node.attribs.class.split(/\s+/) : [])
}
const hasClass = (node, c) => classes(node).includes(c)

function convertBlock ($, node, st, depth) {
  const name = node.name
  const cls = classes(node)

  // Headings that appear as direct children (section titles live inside
  // .sectN wrappers, handled below, but be robust to bare headings too).
  if (/^h[1-6]$/.test(name)) return heading($, node, st)

  if (name === 'table' && cls.includes('tableblock')) return convertTable($, node, st)
  if (name === 'ul' || name === 'ol') return convertList($, node, st, depth, name === 'ol')
  if (name === 'pre') return convertPre($, node)
  if (name === 'p') return inline($, node, st)

  // div-based blocks, dispatched by Asciidoctor class.
  if (cls.includes('sect1') || cls.includes('sect2') || cls.includes('sect3') ||
      cls.includes('sect4') || cls.includes('sect5')) {
    return convertSection($, node, st, depth)
  }
  if (cls.includes('paragraph')) {
    const p = $(node).children('p').first()
    return inline($, (p[0] || node), st)
  }
  if (cls.includes('admonitionblock')) return convertAdmonition($, node, st, depth)
  if (cls.includes('listingblock') || cls.includes('literalblock')) return convertListing($, node, st)
  if (cls.includes('imageblock')) return convertImageBlock($, node, st)
  if (cls.includes('tabset')) return convertTabs($, node, st, depth)
  if (cls.includes('olist')) return convertList($, $(node).children('ol')[0], st, depth, true)
  if (cls.includes('ulist')) return convertList($, $(node).children('ul')[0], st, depth, false)
  if (cls.includes('dlist')) return serializeJsx($, $(node).children('dl')[0], st)
  if (cls.includes('quoteblock') || cls.includes('verseblock')) return convertQuote($, node, st, depth)

  // Structural wrappers with no output of their own: recurse into their content.
  if (node.attribs && node.attribs.id === 'preamble') return convertChildren($, node, st, depth)
  if (cls.includes('sectionbody') || cls.includes('openblock') || cls.includes('exampleblock') ||
      cls.includes('content') || cls.includes('sidebarblock') || name === 'div') {
    const inner = $(node).children('.content')[0] || node
    return convertChildren($, inner, st, depth)
  }

  // Unknown element: fall back to a faithful raw-HTML rendering.
  return serializeJsx($, node, st)
}

function heading ($, node, st) {
  const level = Number(node.name[1])
  const id = node.attribs && node.attribs.id
  const text = inlineFrom($, node.children, st, { skipAnchors: true }).trim()
  // Advance the page slugger for EVERY heading (keeps duplicate-suffix state in
  // sync with Docusaurus) and compute the id Docusaurus would auto-generate.
  const autoId = st.slugger.slug($(node).text().replace(/\s+/g, ' ').trim())
  // Only pin the id explicitly when it would otherwise differ (custom ids like
  // #prereqs, or case like #Troubleshooting). Where Docusaurus already produces
  // the same id, the explicit form is pure noise, so we drop it. Pinned via
  // Docusaurus's MDX-safe explicit-id syntax -- an MDX comment `{/* #id */}`
  // (the classic `{#id}` cannot be used: in .mdx `{` opens a JS expression and
  // `#id` is not parseable, which breaks the build).
  const suffix = id && id !== autoId ? ` {/* #${id} */}` : ''
  return '#'.repeat(level) + ' ' + text + suffix
}

function convertSection ($, node, st, depth) {
  const parts = []
  for (const child of node.children || []) {
    if (child.type !== 'tag') continue
    if (/^h[1-6]$/.test(child.name)) parts.push(heading($, child, st))
    else if (hasClass(child, 'sectionbody')) parts.push(convertChildren($, child, st, depth))
    else parts.push(convertBlock($, child, st, depth))
  }
  return parts.filter((p) => p && p.trim()).join('\n\n')
}

function convertQuote ($, node, st, depth) {
  const content = $(node).find('blockquote')[0] || $(node).children('.content')[0] || node
  const inner = convertChildren($, content, st, depth)
  return inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n')
}

// --- lists -----------------------------------------------------------------

function convertList ($, listEl, st, depth, ordered) {
  if (!listEl) return ''
  const items = $(listEl).children('li').toArray()
  const lines = []
  items.forEach((li, i) => {
    const marker = ordered ? `${i + 1}.` : '-'
    const indent = ' '.repeat(marker.length + 1)
    const blocks = convertListItem($, li, st, depth)
    const text = blocks.filter((b) => b && b.trim()).join('\n\n')
    const itemLines = text.split('\n')
    lines.push(marker + ' ' + (itemLines[0] || ''))
    for (const l of itemLines.slice(1)) lines.push(l === '' ? '' : indent + l)
  })
  return lines.join('\n')
}

function convertListItem ($, li, st, depth) {
  const out = []
  const children = (li.children || []).filter((c) => c.type === 'tag')
  let idx = 0
  // Principal text: Asciidoctor's leading <p> sits on the marker line.
  if (children[0] && children[0].name === 'p') { out.push(inline($, children[0], st)); idx = 1 }
  for (; idx < children.length; idx++) out.push(convertBlock($, children[idx], st, depth + 1))
  if (out.length === 0) out.push(inline($, li, st))
  return out
}

// --- admonitions -----------------------------------------------------------

function convertAdmonition ($, node, st, depth) {
  const type = ADMONITION_TYPES.find((t) => hasClass(node, t)) || 'note'
  const content = $(node).find('td.content').first()[0]
  const body = content ? blockOrInline($, content, st, depth) : ''
  return `:::${type}\n\n${body.trim()}\n\n:::`
}

// A container whose content may be block-level (wrapped in .paragraph/.ulist/...)
// or bare inline text (Asciidoctor emits admonition/cell text without a <p>).
function blockOrInline ($, container, st, depth) {
  const hasBlocks = (container.children || []).some((c) =>
    c.type === 'tag' && (c.name === 'ul' || c.name === 'ol' || c.name === 'table' || c.name === 'pre' ||
      /^(paragraph|ulist|olist|listingblock|literalblock|admonitionblock|imageblock|sect\d|olist|dlist|openblock|exampleblock)$/.test(classes(c).join(' ')) ||
      classes(c).some((k) => /paragraph|ulist|olist|listingblock|literalblock|admonitionblock|imageblock|openblock|exampleblock|dlist/.test(k))))
  if (hasBlocks) return convertChildren($, container, st, depth)
  return inline($, container, st)
}

// --- code ------------------------------------------------------------------

function convertListing ($, node, st) {
  const pre = $(node).find('pre')[0]
  const title = $(node).children('.title').first().text().trim()
  if (!pre) return ''
  return preToFence($, pre, title)
}

function convertPre ($, node) {
  return preToFence($, node, '')
}

function preToFence ($, pre, title) {
  const code = $(pre).find('code')[0]
  let lang = ''
  const langSrc = code || pre
  const dataLang = langSrc.attribs && langSrc.attribs['data-lang']
  if (dataLang) lang = dataLang
  else {
    const m = classes(langSrc).find((c) => c.startsWith('language-'))
    if (m) lang = m.slice('language-'.length)
  }
  const text = $(code || pre).text().replace(/\n$/, '')
  const info = lang + (title ? ` title=${jsxAttr(title)}` : '')
  return fencedCode(text, info)
}

// --- images ----------------------------------------------------------------

function convertImageBlock ($, node, st) {
  const img = $(node).find('img')[0]
  if (!img) return ''
  return imageMd($, img, st)
}

function imageMd ($, img, st) {
  const alt = (img.attribs && img.attribs.alt) || ''
  const src = resolveHref((img.attribs && img.attribs.src) || '', st.pageUrl).href
  return `![${alt.replace(/([[\]])/g, '\\$1')}](${src})`
}

// --- tabs ------------------------------------------------------------------

function convertTabs ($, node, st, depth) {
  st.imports.add("import Tabs from '@theme/Tabs';")
  st.imports.add("import TabItem from '@theme/TabItem';")
  const labelList = $(node).children('.ulist.tabs').find('> ul > li').toArray()
  const panes = $(node).children('.content').children('.tab-pane').toArray()
  const items = []
  panes.forEach((pane, i) => {
    const li = labelList[i]
    const anchor = li ? $(li).find('a[id]')[0] : null
    const labelText = li ? $(li).find('p').text().trim() : `Tab ${i + 1}`
    const id = anchor && anchor.attribs.id
    const value = id ? id.replace(/^tabset\d+_/, '') : slug(labelText)
    // Convert the whole tab-pane: content is usually wrapped in an .openblock,
    // but Asciidoctor also emits pane-level siblings (e.g. an admonition after
    // the block). Recursing the pane picks those up; the .openblock unwraps
    // itself in convertBlock.
    const paneBody = convertChildren($, pane, st, depth).trim()
    items.push(
      `<TabItem value=${jsxAttr(value)} label=${jsxAttr(labelText)}>\n\n${paneBody}\n\n</TabItem>`
    )
  })
  return `<Tabs>\n${items.join('\n')}\n</Tabs>`
}

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// --- tables ----------------------------------------------------------------

function convertTable ($, table, st) {
  const headRows = $(table).children('thead').children('tr').toArray()
  const bodyRows = [
    ...$(table).children('tbody').children('tr').toArray(),
    ...$(table).children('tfoot').children('tr').toArray(),
  ]
  // Direct cells only (do not descend into an admonition's inner table).
  const rowCells = (rows) => rows.flatMap((tr) => $(tr).children('th,td').toArray())
  const cells = [...rowCells(headRows), ...rowCells(bodyRows)]
  const complex = cells.some((c) => isComplexCell($, c))
  const spanned = cells.some((c) => hasSpan(c))
  // A GFM pipe table can only hold inline cells, no spans, and one header row.
  if (!complex && !spanned && headRows.length === 1) return gfmTable($, headRows[0], bodyRows, st)
  // Everything else becomes a clean semantic <table> whose cells are Markdown:
  // MDX parses block content (lists, admonitions, multiple paragraphs) inside a
  // <td> when the body is blank-line padded. No presentational classes emitted.
  return htmlTable($, headRows, bodyRows, st)
}

function isComplexCell ($, cell) {
  // A cell is "complex" if it holds anything Markdown table cells cannot: a
  // list, code, admonition, multiple paragraphs, or a nested table.
  const $c = $(cell)
  if ($c.find('ul, ol, pre, table, .admonitionblock, .ulist, .olist, .listingblock, .dlist').length) return true
  if ($c.find('.paragraph').length > 1) return true
  if ($c.children('p').length > 1) return true // multi-paragraph non-AsciiDoc cell
  return false
}

function hasSpan (cell) {
  const a = cell.attribs || {}
  return +a.colspan > 1 || +a.rowspan > 1
}

function gfmTable ($, headRow, bodyRows, st) {
  const head = $(headRow).children('th,td').toArray().map((c) => cellInline($, c, st))
  const sep = head.map(() => '---')
  const rows = bodyRows.map((tr) =>
    $(tr).children('th,td').toArray().map((c) => cellInline($, c, st)))
  const fmt = (cols) => '| ' + cols.join(' | ') + ' |'
  return [fmt(head), fmt(sep), ...rows.map(fmt)].join('\n')
}

function cellInline ($, cell, st) {
  // Simple cell: unwrap the .content/.paragraph/<p> and render inline; pipes and
  // newlines must not break the row.
  const inner = $(cell).find('p').first()[0] || cell
  return inline($, inner, st, { cell: true }).replace(/\s*\n\s*/g, ' ').trim()
}

// A clean semantic <table> with Markdown cell bodies. Structural tags sit at
// column 0 (indenting a closing tag after a list breaks the MDX parser), and a
// cell whose Markdown spans lines is blank-line padded so MDX reads the body as
// Markdown (lists, admonitions, paragraphs) rather than raw text.
function htmlTable ($, headRows, bodyRows, st) {
  const out = ['<table>']
  if (headRows.length) {
    out.push('<thead>')
    for (const tr of headRows) out.push(rowHtml($, tr, st))
    out.push('</thead>')
  }
  out.push('<tbody>')
  for (const tr of bodyRows) out.push(rowHtml($, tr, st))
  out.push('</tbody>', '</table>')
  return out.join('\n')
}

function rowHtml ($, tr, st) {
  const cells = $(tr).children('th,td').toArray().map((c) => cellHtml($, c, st))
  return '<tr>\n' + cells.join('\n') + '\n</tr>'
}

function cellHtml ($, cell, st) {
  const tag = cell.name === 'th' ? 'th' : 'td'
  const attrs = spanAttrs(cell)
  const md = cellMarkdown($, cell, st)
  // Block form (blank-line padded) whenever the cell holds block content, so
  // MDX parses it as Markdown. `isComplexCell` catches the single-line cases
  // `md.includes('\n')` misses -- e.g. a one-item list `- foo`.
  const block = md !== '' && (isComplexCell($, cell) || md.includes('\n'))
  if (block) return `<${tag}${attrs}>\n\n${md}\n\n</${tag}>`
  return `<${tag}${attrs}>${md}</${tag}>`
}

// Convert one cell's inner HTML to Markdown, reusing the block/inline
// converters. AsciiDoc cells (`a|`) wrap their blocks in a `.content` div;
// plain cells hold one or more `<p class="tableblock">`.
function cellMarkdown ($, cell, st) {
  const content = $(cell).children('.content')[0]
  if (content) return blockOrInline($, content, st, 0).trim()
  const ps = $(cell).children('p').toArray()
  if (ps.length > 1) return ps.map((p) => inline($, p, st).trim()).filter(Boolean).join('\n\n')
  return inline($, cell, st).trim()
}

function spanAttrs (cell) {
  const a = cell.attribs || {}
  let out = ''
  if (+a.colspan > 1) out += ` colSpan={${+a.colspan}}`
  if (+a.rowspan > 1) out += ` rowSpan={${+a.rowspan}}`
  return out
}

// ---------------------------------------------------------------------------
// Inline level
// ---------------------------------------------------------------------------

function inline ($, node, st, opt = {}) {
  return inlineFrom($, node.children, st, opt).replace(/[ \t]+\n/g, '\n').trim()
}

function inlineFrom ($, nodes, st, opt = {}) {
  let out = ''
  for (const n of nodes || []) {
    if (n.type === 'text') {
      out += escapeInlineText(n.data, opt)
    } else if (n.type === 'tag') {
      out += inlineTag($, n, st, opt)
    }
  }
  return out
}

function escapeInlineText (data, opt) {
  const collapsed = data.replace(/\s+/g, ' ')
  const esc = opt.cell ? mdEscapeCell(collapsed) : mdEscape(collapsed)
  return esc
}

function inlineTag ($, node, st, opt) {
  const name = node.name
  const cls = classes(node)
  const kids = () => inlineFrom($, node.children, st, opt)
  switch (name) {
    case 'strong': case 'b': return `**${kids()}**`
    case 'em': return `*${kids()}*`
    case 'i':
      // Asciidoctor renders emphasis as <em>; <i> is ALWAYS a font icon
      // (checklist checkbox, external-link marker, ...). Icons carry no text and
      // must be dropped -- treating them as italic emits an empty `**`/`*`.
      if (cls.some((c) => c === 'fa' || c.startsWith('fa-') || c.startsWith('icon-'))) return ''
      return kids().trim() ? `*${kids()}*` : ''
    case 'code': return inlineCode($(node).text())
    case 'br': return '<br/>'
    case 'a': {
      const id = node.attribs && node.attribs.id
      // Preserve a bare inline anchor target (`<a id="step-5"></a>`) as an
      // id-bearing element so `#step-5` links still resolve; without this the
      // anchor is dropped and Layer 3 reports dead-anchor-self.
      const anchorEl = id ? `<span id=${jsxAttr(id)}></span>` : ''
      if (cls.includes('anchor')) return opt.skipAnchors ? '' : anchorEl // heading self-link: no text
      const label = kids().trim()
      const { kind, href } = resolveHref((node.attribs && node.attribs.href) || '', st.pageUrl)
      if (kind === 'empty' || label === '') return anchorEl + label
      const safeLabel = label.replace(/\]/g, '\\]')
      const safeHref = /[()\s]/.test(href) ? `<${href}>` : href
      return anchorEl + `[${safeLabel}](${safeHref})`
    }
    case 'span': {
      if (cls.includes('image')) {
        const img = $(node).find('img')[0]
        return img ? imageMd($, img, st) : ''
      }
      return kids()
    }
    case 'img': return imageMd($, node, st)
    case 'sup': case 'sub': case 'kbd': case 'mark': case 'u': case 'small': case 'del': case 'ins':
      return `<${name}>${kids()}</${name}>`
    default:
      return kids()
  }
}

// ---------------------------------------------------------------------------
// JSX-safe raw HTML serializer (for tables / dlists / unknown blocks)
// ---------------------------------------------------------------------------

function serializeJsx ($, node, st) {
  if (!node) return ''
  return serNode($, node, st).trim()
}

function serNode ($, node, st) {
  if (node.type === 'text') {
    // Collapse any whitespace run containing a newline to a single newline, so
    // no BLANK line survives inside a raw-HTML block (a blank line would break
    // MDX out of the JSX element). Inline spaces (no newline) are preserved.
    return jsxText(node.data.replace(/[ \t]*\n[ \t\n]*/g, '\n'))
  }
  if (node.type !== 'tag') return ''
  const name = node.name
  const cls = classes(node)

  // Skip empty heading self-anchors and presentational colgroups.
  if (name === 'a' && cls.includes('anchor')) return ''
  if (name === 'colgroup' || name === 'col') return ''
  if (name === 'caption') return '' // auto-numbered "Table N." caption: renderer noise

  // Map an Asciidoctor admonition block to a Docusaurus-detectable admonition
  // div (the fidelity Docusaurus profile matches `.admonition` + a type word).
  if (cls.includes('admonitionblock')) {
    const type = ADMONITION_TYPES.find((t) => cls.includes(t)) || 'note'
    const content = $(node).find('td.content').first()[0]
    const inner = content ? serChildren($, content, st) : ''
    return `<div className="admonition admonition-${type}">${inner}</div>`
  }
  // Unwrap Asciidoctor's presentational .paragraph wrapper to a plain <p>.
  if (cls.includes('paragraph')) {
    const p = $(node).children('p')[0]
    return `<p>${p ? serChildren($, p, st) : serChildren($, node, st)}</p>`
  }

  const attrs = serAttrs(node, st)
  if (VOID_ELEMENTS.has(name)) return `<${name}${attrs} />`

  // Table layout: structural containers put each child on its own line (flow
  // JSX, readable), but a CELL keeps its entire content on ONE line. MDX parses
  // a cell as flow JSX at line start; if the cell's nested block content spanned
  // lines, MDX would try to read it as a markdown paragraph and fail to match
  // the inner tags ("Expected a closing tag ... before the end of paragraph").
  if (TABLE_CONTAINERS.has(name)) {
    const inner = serChildList($, node, st)
    return inner.length ? `<${name}${attrs}>\n${inner.join('\n')}\n</${name}>` : `<${name}${attrs}></${name}>`
  }
  if (TABLE_CELLS.has(name)) {
    const inner = serChildren($, node, st).replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim()
    return `<${name}${attrs}>${inner}</${name}>`
  }

  return `<${name}${attrs}>${serChildren($, node, st)}</${name}>`
}

const TABLE_CONTAINERS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr'])
const TABLE_CELLS = new Set(['td', 'th'])

function serChildren ($, node, st) {
  let out = ''
  for (const c of node.children || []) out += serNode($, c, st)
  return out
}

// Serialize element/text children, dropping whitespace-only results so a
// container can join real children with newlines without blank gaps.
function serChildList ($, node, st) {
  const parts = []
  for (const c of node.children || []) {
    const s = serNode($, c, st)
    if (s && s.trim()) parts.push(s.trim())
  }
  return parts
}

function serAttrs (node, st) {
  let out = ''
  const a = node.attribs || {}
  for (const [k, v] of Object.entries(a)) {
    if (!JSX_KEEP.has(k) && !k.startsWith('aria-')) continue
    let name = JSX_ATTR_MAP[k] || k
    let value = v
    if (k === 'href' || k === 'src') value = resolveHref(v, st.pageUrl).href
    out += ` ${name}=${jsxAttr(value)}`
  }
  return out
}

module.exports = { convertBody, serializeJsx, ADMONITION_TYPES }
