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

const path = require('node:path')
const cheerio = require('cheerio')
const GithubSlugger = require('github-slugger')
const { mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode } = require('./mdx')
const { resolveHref } = require('./links')

const ADMONITION_TYPES = ['note', 'tip', 'warning', 'caution', 'important']
// `<strong class="…">` classes that are inline badges (from Asciidoctor
// `[.enterprise]*…*` roles) -> the global <Badge type> component, keyed by the
// front-end BADGES registry. Any other strong class (align=*, navy, blue) is
// presentational and stays plain bold.
const BADGE_CLASSES = new Set(['enterprise', 'serverless', 'dedicated', 'beta', 'experimental'])
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
//   ctx: { pageUrl, partials }
//   partials: Map(id -> { componentName, importStmt, ... }) of FACTORED partials
//   (see converter/lib/partials.js). A sentinel region whose id is in the map is
//   replaced by a <Component/> reference + import; any other sentinel region is
//   inlined (sentinels removed, content converted as normal). Absent/empty map
//   => every region inlines, i.e. today's behaviour.
function convertBody (html, ctx) {
  const $ = cheerio.load(html, null, false)
  // A per-page slugger mirrors how Docusaurus derives heading ids, so we can
  // detect (and drop) the explicit id where it would match the auto-generated
  // one. It is stateful across the page (duplicate headings get -1, -2 ...), so
  // it must see EVERY heading in document order -- see heading().
  const state = {
    imports: new Set(),
    pageUrl: ctx.pageUrl,
    // Output file path of the page/partial being converted, RELATIVE to the
    // component out dir (e.g. "develop-applications/foo/overview.mdx"). Images
    // are co-located, so their references are computed relative to this — see
    // imageSrc(). Falls back to the URL layout when absent.
    relFile: (ctx.relFile || '').replace(/\\/g, '/'),
    component: ctx.component || (ctx.pageUrl || '').split('/').filter(Boolean)[0] || '',
    slugger: new GithubSlugger(),
    partials: ctx.partials || new Map(),
    linkVars: ctx.linkVars || new Map(),
    // Single-sourced examples: content -> co-located file path (from convert.js
    // loadExamples). exampleVars/usedVarNames dedupe imports within one page.
    examples: ctx.examples || new Map(),
    exampleVars: new Map(),
    usedVarNames: new Set(),
    // Single-sourced doc variables to put BACK (value -> name), scoped to the
    // attributes this page's SOURCE references (from convert.js) so a matching
    // string elsewhere is never touched. Prose -> <Variable>; code -> `{name}`
    // placeholder + a `vars` fence flag the swizzled CodeBlock resolves.
    pageVars: ctx.pageVars || new Map(),
    // component -> current stable latest version, for floating versionless
    // cross-component xrefs to `/<comp>/latest/` (see floatCrossComponentLatest).
    latestVersions: ctx.latestVersions || {},
  }
  collapseSentinels($, $.root()[0], state)
  const body = convertChildren($, $.root()[0], state, 0)
  return { body: body.trim(), imports: state.imports }
}

// Rewrite partial-boundary sentinels in the parsed DOM before conversion: a
// factored region collapses to a single <hzpartial data-id> placeholder (its
// inner blocks dropped -- they live in the partial file now); a non-factored
// region is unwrapped in place (sentinels removed, inner blocks kept). Regions
// do not nest, so a linear scan per parent suffices; recurse into what remains.
function collapseSentinels ($, node, st) {
  const kids = node.children || []
  const out = []
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    if (c.type === 'comment') {
      const m = c.data.trim().match(/^hz-partial:start (.+)$/)
      if (m) {
        const id = m[1].trim()
        const endMark = `hz-partial:end ${id}`
        const inner = []
        let j = i + 1
        while (j < kids.length && !(kids[j].type === 'comment' && kids[j].data.trim() === endMark)) {
          inner.push(kids[j]); j++
        }
        const d = st.partials.get(id)
        if (d) {
          out.push({ type: 'tag', name: 'hzpartial', attribs: { 'data-id': id }, children: [], parent: node })
        } else {
          for (const n of inner) { n.parent = node; out.push(n) }
        }
        i = j // skip the inner nodes; the loop's i++ steps past the end comment
        continue
      }
      continue // stray/other comment: drop (convertChildren ignored these anyway)
    }
    out.push(c)
  }
  node.children = out
  for (const c of out) if (c.type === 'tag' && c.name !== 'hzpartial') collapseSentinels($, c, st)
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

// Attribute-reference marker span (antora-extension/mark-attributes.js): a
// `<span class="hz-attr-NAME">value</span>` marks exactly where source had
// `{NAME}`. The converter turns it back into a <Variable> reference (globally
// registered, so no import) instead of baking `value`. markerName returns NAME
// or null.
const HZ_ATTR_PREFIX = 'hz-attr-'
const markerName = (node) => {
  const c = classes(node).find((x) => x.startsWith(HZ_ATTR_PREFIX))
  return c ? c.slice(HZ_ATTR_PREFIX.length) : null
}

// A node's visible text with each marker span rendered as its `{NAME}` token
// (the rest literal). Used for the `text` of a link-mode <Variable>, which the
// component resolves per version -- so a marked reference inside a link label
// stays a reference instead of being baked.
function markerText ($, node) {
  let out = ''
  for (const n of node.children || []) {
    if (n.type === 'text') out += n.data
    else if (n.type === 'tag') {
      const nm = markerName(n)
      out += nm ? `{${nm}}` : markerText($, n)
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

function convertBlock ($, node, st, depth) {
  const name = node.name
  const cls = classes(node)

  // Factored-partial placeholder (see collapseSentinels): emit the component
  // reference and record its import. The fragment's content lives in the
  // partial file, so nothing else is rendered here.
  if (name === 'hzpartial') {
    const d = st.partials.get(node.attribs['data-id'])
    if (!d) return ''
    st.imports.add(d.importStmt)
    return `<${d.componentName}/>`
  }

  // Headings that appear as direct children (section titles live inside
  // .sectN wrappers, handled below, but be robust to bare headings too).
  if (/^h[1-6]$/.test(name)) return heading($, node, st)

  if (name === 'table' && cls.includes('tableblock')) return convertTable($, node, st)
  if (name === 'ul' || name === 'ol') return convertList($, node, st, depth, name === 'ol')
  if (name === 'pre') return convertPre($, node, st)
  if (name === 'p') return inline($, node, st)
  if (name === 'details') return convertDetails($, node, st, depth)

  // div-based blocks, dispatched by Asciidoctor class.
  if (cls.includes('sect1') || cls.includes('sect2') || cls.includes('sect3') ||
      cls.includes('sect4') || cls.includes('sect5')) {
    return convertSection($, node, st, depth)
  }
  if (cls.includes('paragraph')) {
    const p = $(node).children('p').first()
    return escapeBlockStart(inline($, (p[0] || node), st))
  }
  if (cls.includes('admonitionblock')) return convertAdmonition($, node, st, depth)
  // `literalblock` is the standalone literal block; the bare `literal` class is
  // the form Asciidoctor uses for a literal block nested in a table cell.
  if (cls.includes('listingblock') || cls.includes('literalblock') || cls.includes('literal')) return convertListing($, node, st)
  if (cls.includes('imageblock')) return convertImageBlock($, node, st)
  if (cls.includes('tabset')) return convertTabs($, node, st, depth)
  if (cls.includes('olist')) return convertList($, $(node).children('ol')[0], st, depth, true)
  if (cls.includes('ulist')) return convertList($, $(node).children('ul')[0], st, depth, false)
  if (cls.includes('dlist')) return convertDlist($, $(node).children('dl')[0], st, depth)
  if (cls.includes('colist')) return convertColist($, node, st, depth)
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
  // Pin the id explicitly when it would otherwise differ (custom ids like
  // #prereqs, or case like #Troubleshooting), OR when the heading carries a
  // <Variable> (a marked attribute reference): Docusaurus derives the slug from
  // the heading TEXT, which it cannot read through the component, so the id must
  // be pinned even though it matches the golden text's slug. Where neither holds,
  // the explicit form is pure noise, so we drop it. Pinned via Docusaurus's
  // MDX-safe explicit-id syntax -- an MDX comment `{/* #id */}` (the classic
  // `{#id}` cannot be used: in .mdx `{` opens a JS expression and `#id` is not
  // parseable, which breaks the build).
  const hasVariable = text.includes('<Variable')
  const suffix = id && (id !== autoId || hasVariable) ? ` {/* #${id} */}` : ''
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

// --- description lists -------------------------------------------------------

// A clean <dl> whose <dd> bodies are Markdown (same technique as complex table
// cells): MDX parses block content -- paragraphs, lists, admonitions -- inside a
// <dd> when it is blank-line padded, so no Asciidoctor `.hdlist1`/`.paragraph`/
// `<div className="admonition">` wrappers are emitted. Terms carry inline
// Markdown (verified: `**term**` parses inside a single-line <dt>).
function convertDlist ($, dl, st, depth) {
  if (!dl) return ''
  const out = ['<dl>']
  for (const node of dl.children || []) {
    if (node.type !== 'tag') continue
    if (node.name === 'dt') {
      const term = inline($, node, st).replace(/\s*\n\s*/g, ' ').trim()
      out.push(`<dt>${term}</dt>`)
    } else if (node.name === 'dd') {
      const md = blockOrInline($, node, st, depth).trim()
      // Block (blank-line padded) form when the dd holds block content; a plain
      // single-paragraph dd stays inline. Asciidoctor wraps every block after
      // the first paragraph in a <div>, so a div/list/pre/table child signals
      // block content that `md.includes('\n')` alone would miss (one-item list).
      const block = md !== '' && ($(node).children('div, ul, ol, pre, table').length > 0 || md.includes('\n'))
      if (md === '') out.push('<dd></dd>')
      else if (block) out.push(`<dd>\n\n${md}\n\n</dd>`)
      else out.push(`<dd>${md}</dd>`)
    }
  }
  out.push('</dl>')
  return out.join('\n')
}

// Asciidoctor callout list (colist): the numbered annotations tied to a code
// block's conum markers (`<1>`, `<2>` in the source). It renders in the golden
// as a bare <table> (number cell + description cell) with NO `tableblock` class,
// so it is NOT a data table -- emitting a Markdown/HTML <table> would both
// misrepresent it and get row-ified by the fidelity table compare (`│ 1 │ …`).
// Each row becomes one paragraph `**N** description`: the number stays visible
// text and the row reads as a single line, matching how Antora's colist renders
// (number cell + description cell joined). The description uses the same
// block/inline handling as cells, so a rare multi-block annotation still holds.
function convertColist ($, node, st, depth) {
  const rows = $(node).find('tr').toArray()
  if (!rows.length) return serializeJsx($, node, st)
  const out = []
  let n = 0
  for (const tr of rows) {
    const tds = $(tr).children('td').toArray()
    if (tds.length < 2) continue
    const desc = blockOrInline($, tds[1], st, depth).trim()
    if (desc === '') continue
    n++
    // A plain Markdown numbered list item. Continuation lines of a block
    // description (e.g. backup-restore's nested list) are indented to stay inside
    // the item so it parses as one list entry.
    const body = desc.split('\n').map((l, i) => (i === 0 || l === '' ? l : '   ' + l)).join('\n')
    out.push(`${n}. ${body}`)
  }
  // The <CodeCallouts> component (globally registered) renders this Markdown
  // numbered list as the circled, indented callout list. Authors write the same
  // clean list for new pages — no raw HTML, no per-line markup.
  return `<CodeCallouts>\n\n${out.join('\n')}\n\n</CodeCallouts>`
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
      /^(paragraph|ulist|olist|listingblock|literalblock|literal|admonitionblock|imageblock|sect\d|olist|dlist|openblock|exampleblock)$/.test(classes(c).join(' ')) ||
      classes(c).some((k) => /paragraph|ulist|olist|listingblock|literalblock|literal|admonitionblock|imageblock|openblock|exampleblock|dlist/.test(k))))
  if (hasBlocks) return convertChildren($, container, st, depth)
  return inline($, container, st)
}

// --- collapsible ------------------------------------------------------------

// Asciidoctor's [%collapsible] block renders to
//   <details><summary class="title">TITLE</summary><div class="content">BODY</div></details>
// <details> is the idiomatic Docusaurus collapsible (MDX has no Markdown form for
// one), so it stays -- but we drop Antora's UI scaffolding: the summary's `title`
// class and the `.content` wrapper div, neither of which Docusaurus's Details
// theme needs. The body converts to native Markdown (convertChildren also turns a
// factored-partial region into its <Component/>). `[%collapsible%open]` sets
// `open` on the <details>; preserve it. Blank lines around the body are required
// for MDX to parse it as Markdown rather than raw text.
function convertDetails ($, node, st, depth) {
  const contentEl = $(node).children('div.content')[0]
  // Unexpected shape (no .content wrapper): stay faithful via the raw serializer.
  if (!contentEl) return serializeJsx($, node, st)
  const summaryEl = $(node).children('summary')[0]
  const summary = summaryEl ? inline($, summaryEl, st).trim() : ''
  const body = convertChildren($, contentEl, st, depth).trim()
  const open = node.attribs && 'open' in node.attribs ? ' open' : ''
  return `<details${open}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
}

// --- code ------------------------------------------------------------------

function convertListing ($, node, st) {
  const pre = $(node).find('pre')[0]
  const title = $(node).children('.title').first().text().trim()
  if (!pre) return ''
  // Single-sourced example include: when this code block's content matches a
  // co-located example file, import it (raw-loader) and render via <CodeBlock>
  // instead of baking the fence -- keeps the example file the single source.
  if (st.examples && st.examples.size) {
    const codeEl = $(pre).find('code')[0]
    const hit = st.examples.get(normalizeCode($(codeEl || pre).text()))
    if (hit) return emitExampleCodeBlock($, pre, hit.file, title, st, hit.conums)
  }
  return preToFence($, pre, title, st)
}

// Match key for code content: strip trailing newlines/blank lines (mirrors
// convert.js normalizeCode and preToFence's trailing-newline trim).
const normalizeCode = (s) => s.replace(/\n+$/, '')

// A stable, unique JS identifier for a page's import of an example file.
function exampleVar (file, st) {
  if (st.exampleVars.has(file)) return st.exampleVars.get(file)
  let base = 'Ex_' + file.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  let name = base
  let n = 2
  while (st.usedVarNames.has(name)) name = `${base}_${n++}`
  st.usedVarNames.add(name)
  st.exampleVars.set(file, name)
  return name
}

// Path from the page's output dir to the co-located examples/ dir (at the
// version-tree root), for the raw-loader import. Webpack needs a `./`-relative
// specifier.
function examplesRelPath (relFile) {
  const dir = path.posix.dirname((relFile || '').split(/[\\/]/).join('/'))
  const rel = path.posix.relative(dir === '' ? '.' : dir, 'examples')
  return rel.startsWith('.') ? rel : './' + rel
}

function emitExampleCodeBlock ($, pre, file, title, st, conums) {
  const codeEl = $(pre).find('code')[0]
  let lang = ''
  const langSrc = codeEl || pre
  const dataLang = langSrc.attribs && langSrc.attribs['data-lang']
  if (dataLang) lang = dataLang
  else {
    const m = classes(langSrc).find((c) => c.startsWith('language-'))
    if (m) lang = m.slice('language-'.length)
  }
  const varName = exampleVar(file, st)
  st.imports.add("import CodeBlock from '@theme/CodeBlock';")
  // Plain import: a scoped webpack rule (example-attributes-plugin) runs the
  // example-attributes loader + raw-loader on files under examples/, so any
  // Antora {attribute} placeholders in the byte-faithful file are substituted
  // per version at build (no-op for files without placeholders).
  st.imports.add(`import ${varName} from '${examplesRelPath(st.relFile)}/${file}';`)
  // Files carrying native `<N>` conum markers get the `conums` metastring so the
  // swizzled CodeBlock strips the markers and renders callout badges.
  const info = (lang ? ` language=${jsxAttr(lang)}` : '') + (title ? ` title=${jsxAttr(title)}` : '') +
    (conums ? ' metastring="conums"' : '')
  return `<CodeBlock${info}>{${varName}}</CodeBlock>`
}

function convertPre ($, node, st) {
  return preToFence($, node, '', st)
}

// --- single-sourced variable reverse-mapping -------------------------------
// Antora resolved {attribute} refs in the golden; per the no-baking rule we put
// version-number values BACK to references. `pageVars` (value -> name) is scoped
// (in convert.js) to the attributes the page's SOURCE references, so an
// unrelated occurrence of the same string is never touched. Values match as
// whole tokens, longest first (so a value containing another wins).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const varTokenRe = (value) => new RegExp(`(?<![\\w.-])${escapeRe(value)}(?![\\w.-])`, 'g')
const pageVarsSorted = (pageVars) => [...pageVars].sort((a, b) => b[0].length - a[0].length)

// Prose: replace a resolved value with a <Variable> (globally registered in
// MDXComponents, so no import). Applied to already-escaped inline text.
function reverseProseVars (text, pageVars) {
  if (!pageVars || !pageVars.size) return text
  let out = text
  for (const [value, name] of pageVarsSorted(pageVars)) out = out.replace(varTokenRe(value), `<Variable name="${name}"/>`)
  return out
}

// Code: replace a resolved value with the `{name}` placeholder; the swizzled
// CodeBlock resolves it per version when the fence carries the `vars` flag.
function reverseCodeVars (code, pageVars) {
  if (!pageVars || !pageVars.size) return { code, replaced: false }
  let out = code
  let replaced = false
  for (const [value, name] of pageVarsSorted(pageVars)) {
    const next = out.replace(varTokenRe(value), `{${name}}`)
    if (next !== out) { out = next; replaced = true }
  }
  return { code: out, replaced }
}

function preToFence ($, pre, title, st) {
  const code = $(pre).find('code')[0]
  let lang = ''
  const langSrc = code || pre
  const dataLang = langSrc.attribs && langSrc.attribs['data-lang']
  if (dataLang) lang = dataLang
  else {
    const m = classes(langSrc).find((c) => c.startsWith('language-'))
    if (m) lang = m.slice('language-'.length)
  }
  // Asciidoctor callout numbers (conums) render inside the code as
  // `<i class="conum" data-value="N"></i><b>(N)</b>`. Put the native Asciidoctor
  // `<N>` marker back INLINE on its own line (so it stays glued to that line when
  // the code is edited) and flag the fence with a bare `conums`; the swizzled
  // CodeBlock (src/theme/CodeBlock) strips the `<N>` and re-emits prod's circled
  // badge per line. The bare flag leaves every other code block untouched.
  const { text, hasConums } = extractConums($, code || pre)
  const { code: varsText, replaced } = reverseCodeVars(text, st && st.pageVars)
  let info = lang
  if (title) info += ` title=${jsxAttr(title)}`
  if (hasConums) info += ' conums'
  if (replaced) info += ' vars'
  return fencedCode(varsText.replace(/\n$/, ''), info)
}

// Replace each conum's `<i class="conum">...<b>(N)</b>` markup with the inline
// Asciidoctor marker `<N>`, returning the code text and whether any were found.
// A private-use sentinel is inserted first (cheerio would parse a literal `<N>`
// string as an HTML tag), then rewritten to `<N>` after text extraction.
function extractConums ($, codeEl) {
  const els = $(codeEl).find('i.conum[data-value]').toArray()
  for (const el of els) {
    const val = $(el).attr('data-value')
    $(el).next('b').remove() // the fallback `(N)` text; re-added by the component
    $(el).replaceWith(`\uE000${val}\uE000`)
  }
  let text = $(codeEl).text()
  if (els.length) text = text.replace(/\uE000(\d+)\uE000/g, '<$1>')
  return { text, hasConums: els.length > 0 }
}

// --- images ----------------------------------------------------------------

function convertImageBlock ($, node, st) {
  const img = $(node).find('img')[0]
  if (!img) return ''
  return imageMd($, img, st)
}

function imageMd ($, img, st) {
  const alt = (img.attribs && img.attribs.alt) || ''
  const src = imageSrc((img.attribs && img.attribs.src) || '', st)
  return `![${alt.replace(/([[\]])/g, '\\$1')}](${src})`
}

// Antora resolves a versionless cross-component xref (e.g.
// `xref:hazelcast:getting-started:support.adoc[]`) to the target component's
// LATEST version and bakes the number into the golden: `/hazelcast/5.7/...`.
// Baking the number means the link silently rots the moment that component
// ships a new release. Rewrite it to the production `/<comp>/latest/` redirect
// alias (which the site 307s to the current version) so it always follows the
// latest. Two guards keep this safe:
//   - CROSS-component only: a page's own version tree must keep its exact
//     version (a 5.18 page must go on linking within 5.18, not jump to latest).
//   - version === the component's CURRENT latest: an explicit pin to an older
//     version (`/hazelcast/5.5/`) is a deliberate author choice — leave it.
// `href` is `pathname + hash`, so any `#anchor` rides along in `rest`.
function floatCrossComponentLatest (href, st) {
  const m = href.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/)
  if (!m) return href
  const [, comp, ver, rest] = m
  if (comp === st.component) return href
  if (!st.latestVersions || st.latestVersions[comp] !== ver) return href
  return `/${comp}/latest${rest || '/'}`
}

// Images are CO-LOCATED: each component's images live in an `images/` folder in
// the docs tree (placed by extract-images.js), and pages reference them with a
// path RELATIVE to their own output file, so webpack resolves and content-hashes
// them — a missing image then fails the build instead of 404ing silently.
// resolveHref first canonicalises the golden's page-relative src (e.g.
// "_images/foo.png") to a site-absolute path ("/cloud/_images/foo.png"); we strip
// the component prefix, rename Antora's `_images` dir to our `images`, and
// relativise the rest against the current file's dir. This `_images`->`images`
// rewrite MUST match the one in extract-images.js (dest path), or references and
// files disagree. External srcs, and images outside this component (which we
// cannot co-locate into its tree), keep their resolved absolute form.
function imageSrc (raw, st) {
  const resolved = resolveHref(raw, st.pageUrl)
  if (resolved.kind !== 'internal') return resolved.href
  const abs = resolved.path
  const hash = resolved.hash || ''
  const prefix = st.component ? `/${st.component}/` : ''
  if (!prefix || !abs.startsWith(prefix)) return abs + hash
  const within = abs.slice(prefix.length).replace(/(^|\/)_images\//, '$1images/') // "_images/foo.png" -> "images/foo.png"
  const fromDir = path.posix.dirname(st.relFile || '')
  let rel = path.posix.relative(fromDir === '.' ? '' : fromDir, within)
  if (!rel.startsWith('.')) rel = './' + rel
  return rel + hash
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

// Escape a leading Markdown BLOCK marker on paragraph text so prose that happens
// to begin with `+ `/`- `/`* `/`> `/`# `/`1. ` is not reparsed as a list item,
// blockquote, or heading. Antora renders such text literally (e.g. scale.adoc's
// `+\n.For Openshift` malformed continuation -> a literal paragraph); MDX would
// otherwise eat the marker and synthesize a spurious list item. The trailing
// whitespace guard keeps `-5`, `*emphasis*`, `#hashtag` untouched.
function escapeBlockStart (s) {
  return s
    .replace(/^(\s*)([-+*>])(\s)/, '$1\\$2$3')
    .replace(/^(\s*)(#{1,6})(\s)/, '$1\\$2$3')
    .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4')
}

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

// A `[cols="l"]` (literal) column renders each cell as a single
// `<div class="literal"><pre>…</pre></div>`. When that <pre> is a single line,
// the cell is really inline monospace, so a GFM pipe table with `code` cells
// reads far cleaner than an HTML table whose every cell is a fenced block.
// Returns the line's text, or null when the cell is anything else (including a
// multi-line literal, which stays a real block).
function literalInlineCell ($, cell) {
  const $c = $(cell)
  if ($c.children().length !== 1) return null
  const lit = $c.children('.literal')
  if (lit.length !== 1) return null
  const pre = lit.children('pre')
  if (pre.length !== 1) return null
  const text = $(pre[0]).text()
  return text.includes('\n') ? null : text
}

function isComplexCell ($, cell) {
  // A cell is "complex" if it holds anything Markdown table cells cannot: a
  // list, code, admonition, multiple paragraphs, or a nested table.
  const $c = $(cell)
  // ...except a single-line literal cell, which is inline monospace (`code`).
  if (literalInlineCell($, cell) != null) return false
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
  // A single-line literal (`[cols="l"]`) cell is inline monospace.
  const lit = literalInlineCell($, cell)
  if (lit != null) return inlineCode(lit)
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
  // Block/inline decision for the remaining cases: a cell may hold a block with
  // no `.content` wrapper (e.g. a `<div class="literal">` code block), which must
  // go through the block converters rather than be flattened to inline text.
  return blockOrInline($, cell, st, 0).trim()
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
      out += escapeInlineText(n.data, opt, st)
    } else if (n.type === 'tag') {
      out += inlineTag($, n, st, opt)
    }
  }
  return out
}

function escapeInlineText (data, opt, st) {
  const collapsed = data.replace(/\s+/g, ' ')
  const esc = opt.cell ? mdEscapeCell(collapsed) : mdEscape(collapsed)
  return st && st.pageVars ? reverseProseVars(esc, st.pageVars) : esc
}

function inlineTag ($, node, st, opt) {
  const name = node.name
  const cls = classes(node)
  const kids = () => inlineFrom($, node.children, st, opt)
  switch (name) {
    case 'hzpartial': {
      // Insurance: a factored region should always be block-level, but never let
      // its placeholder silently vanish if it turns up inline.
      const d = st.partials.get(node.attribs['data-id'])
      if (!d) return ''
      st.imports.add(d.importStmt)
      return `<${d.componentName}/>`
    }
    case 'strong': case 'b': {
      const badge = cls.find((c) => BADGE_CLASSES.has(c))
      // <Badge> is globally registered (MDXComponents), so no import is needed.
      // Self-closing: the label is single-sourced in the front-end registry, so
      // the authored text (e.g. "Enterprise Edition") is intentionally dropped.
      if (badge) return `<Badge type=${jsxAttr(badge)}/>`
      return `**${kids()}**`
    }
    case 'em': return `*${kids()}*`
    case 'i':
      // Asciidoctor renders emphasis as <em>; <i> is ALWAYS a font icon
      // (checklist checkbox, external-link marker, ...). Icons carry no text and
      // must be dropped -- treating them as italic emits an empty `**`/`*`.
      if (cls.some((c) => c === 'fa' || c.startsWith('fa-') || c.startsWith('icon-'))) return ''
      return kids().trim() ? `*${kids()}*` : ''
    case 'code': {
      // A monospaced cross-reference renders as `<code><a href>Type</a></code>`
      // (api-ref's field-type columns). Markdown cannot hold a link INSIDE inline
      // code, but it can hold code inside a link LABEL, which is visually
      // identical and keeps the link. Only the single-link case (the CRD pattern)
      // is handled; anything else stays plain inline code.
      const a = $(node).find('a[href]')[0]
      if (a && a.attribs && a.attribs.href) {
        const { kind, href } = resolveHref(a.attribs.href, st.pageUrl)
        // A bare-URL autolink inside code (`<code><a class="bare" href=…>`) whose
        // URL carries literal angle brackets is a placeholder shown AS code, not
        // a real link — and its invalid URL fails Docusaurus compile. Keep it as
        // inline code with no link. Genuine cross-references (api-ref's `#Type`)
        // become a link whose label is code (Markdown allows code in a label).
        if (kind !== 'empty' && kind !== 'malformed' && !/[<>]/.test(href)) {
          const label = inlineCode($(node).text())
          return `[${label}](${/[()\s]/.test(href) ? `<${href}>` : href})`
        }
      }
      return inlineCode($(node).text())
    }
    case 'br': return '<br/>'
    case 'a': {
      const id = node.attribs && node.attribs.id
      // Preserve a bare inline anchor target (`<a id="step-5"></a>`) as an
      // id-bearing element so `#step-5` links still resolve; without this the
      // anchor is dropped and Layer 3 reports dead-anchor-self.
      const anchorEl = id ? `<span id=${jsxAttr(id)}></span>` : ''
      if (cls.includes('anchor')) return opt.skipAnchors ? '' : anchorEl // heading self-link: no text
      const label = kids().trim()
      const rawHref = (node.attribs && node.attribs.href) || ''
      const { kind, href: resolvedHref } = resolveHref(rawHref, st.pageUrl)
      const href = kind === 'internal' ? floatCrossComponentLatest(resolvedHref, st) : resolvedHref
      if (kind === 'empty' || label === '') return anchorEl + label
      // Single-sourced destination: emit the globally-registered <Variable> in
      // link mode (no import needed) instead of baking the URL in. The href is
      // the attribute reference; the visible text goes in `text` (not children,
      // so a `{name}` in it stays literal for the component to resolve). Opens in
      // a new tab (external destinations).
      // Link text with marker tokens: a marked {attr} reference inside the label
      // (e.g. `link:{page-cloud-console}[{hazelcast-cloud} console]`) becomes a
      // `{attr}` token in the visible text, resolved per version by <Variable> /
      // by the raw <a> fallback — never baked.
      const tokenText = markerText($, node)
      const varName = st.linkVars.get(rawHref)
      if (varName) {
        return anchorEl + `<Variable href=${jsxAttr(`{${varName}}`)} text=${jsxAttr(tokenText)}/>`
      }
      // Templated single-sourcing: a version value can be a SUBSTRING of the
      // href and/or label (e.g. the release-notes link `.../{page-cloud-platform-
      // version}/...` with a `{full-version}` label). Reverse-map the page's
      // referenced values (source-scoped, st.pageVars) in the plain href + text;
      // any hit -> emit <Variable> in link mode with the placeholders kept.
      if (st.pageVars && st.pageVars.size && !/[<>]/.test(href)) {
        const { code: hrefTpl, replaced: hrefRep } = reverseCodeVars(href, st.pageVars)
        const { code: textTpl, replaced: textRep } = reverseCodeVars(tokenText, st.pageVars)
        if (hrefRep || textRep) return anchorEl + `<Variable href=${jsxAttr(hrefTpl)} text=${jsxAttr(textTpl)}/>`
      }
      // A href with literal angle brackets (a placeholder pseudo-URL like
      // `http://<mc-ip-address>:8080`) cannot be a link in Docusaurus: it fails
      // URL validation at compile time in EVERY form (Markdown link and raw
      // <a> alike). Keep the visible text (jsxText encodes the brackets) and drop
      // the un-followable link wrapper — the only form that compiles.
      if (/[<>]/.test(href)) return anchorEl + label
      // A marked {attr} reference in the label became a <Variable/> in `label`
      // (via the span case). MDX cannot parse a component inside a `[…]` link
      // label, so emit a raw <a> (Docusaurus routes it through its Link element)
      // with the component in the children.
      if (label.includes('<Variable')) {
        return anchorEl + `<a href=${jsxAttr(href)}>${label}</a>`
      }
      const safeLabel = label.replace(/\]/g, '\\]')
      const safeHref = /[()\s]/.test(href) ? `<${href}>` : href
      return anchorEl + `[${safeLabel}](${safeHref})`
    }
    case 'span': {
      const attr = markerName(node)
      if (attr) return `<Variable name=${jsxAttr(attr)}/>` // marked {attr} reference -> <Variable>
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

  // Factored-partial placeholder inside a raw-HTML/JSX block (e.g. a partial
  // included within a [%collapsible] <details>). A component reference is valid
  // JSX, so emit it and record the import here too.
  if (name === 'hzpartial') {
    const d = st.partials.get(node.attribs['data-id'])
    if (!d) return ''
    st.imports.add(d.importStmt)
    return `<${d.componentName}/>`
  }

  // Marked {attr} reference inside a raw-HTML/JSX block (e.g. a spanned table
  // cell): emit the global <Variable> rather than baking the resolved value.
  if (name === 'span') {
    const attr = markerName(node)
    if (attr) return `<Variable name=${jsxAttr(attr)}/>`
  }

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

  // Inline badge inside a raw-HTML/JSX block (e.g. a spanned table cell): emit
  // the global <Badge> rather than a raw <strong className="enterprise">.
  if (name === 'strong' || name === 'b') {
    const badge = cls.find((c) => BADGE_CLASSES.has(c))
    if (badge) return `<Badge type=${jsxAttr(badge)}/>`
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
    // Links keep their site-absolute form (URL fidelity); image srcs become a
    // co-located relative path (see imageSrc).
    if (k === 'href') value = resolveHref(v, st.pageUrl).href
    else if (k === 'src') value = imageSrc(v, st)
    out += ` ${name}=${jsxAttr(value)}`
  }
  return out
}

module.exports = { convertBody, serializeJsx, ADMONITION_TYPES }
