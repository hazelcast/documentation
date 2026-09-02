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
const {
  mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode,
  breakAutolinks, isPlaceholderUrl, PROSE_URL,
} = require('./mdx')
const { resolveHref, repairApiDeepLink } = require('./links')
const { normalizeValues, groupIdFor } = require('./tabs')
// Trailing-whitespace normalisation for code-template keys: Asciidoctor strips it
// from a rendered verbatim line, so both sides of the match have to.
const { rtrimLines } = require('./code-templates')

const ADMONITION_TYPES = ['note', 'tip', 'warning', 'caution', 'important']
// `<strong class="…">` classes that are inline badges (from Asciidoctor
// `[.enterprise]*…*` roles) -> the global <Badge type> component, keyed by the
// front-end BADGES registry. Any other strong class (align=*, navy, blue) is
// presentational and stays plain bold.
// The `role=` values on a CONTENT icon that src/components/Icon renders. Closed
// set, deliberately: an unlisted role means the front-end registry has no glyph
// for it, so it must be added there before the converter starts emitting it --
// and until then the icon keeps its current (dropped) behaviour rather than
// producing an <Icon> that renders nothing.
const ICON_ROLES = new Set(['success', 'error'])

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
    // Version segment this page is emitted under for a VERSIONED component
    // (e.g. "5.16", or "latest-snapshot" for main); null for unversioned
    // components (cloud). Antora publishes versioned pages under
    // `/<component>/<seg>/…` and co-locates their images at the version-tree
    // root, so imageSrc() must strip this segment too — see imageSrc().
    seg: ctx.seg || null,
    slugger: new GithubSlugger(),
    partials: ctx.partials || new Map(),
    linkVars: ctx.linkVars || new Map(),
    // Single-sourced examples: content -> co-located file path (from convert.js
    // loadExamples). exampleVars/usedVarNames dedupe imports within one page.
    examples: ctx.examples || new Map(),
    // The example files this page's source actually includes; disambiguates a
    // content match when several files hold identical text (chooseExample).
    pageExampleFiles: ctx.pageExampleFiles || new Set(),
    // Block ids already emitted as <Anchor> on this page (convertBlock), so a
    // nested re-visit cannot register the same id twice.
    blockAnchors: new Set(),
    exampleVars: new Map(),
    usedVarNames: new Set(),
    // Single-sourced doc variables to put BACK (value -> name), scoped to the
    // attributes this page's SOURCE references (from convert.js) so a matching
    // string elsewhere is never touched. Prose -> <Variable>; code -> `{name}`
    // placeholder + a `vars` fence flag the swizzled CodeBlock resolves.
    pageVars: ctx.pageVars || new Map(),
    // The prose-only subset of pageVars: a MARKED attribute's value is dropped,
    // because marking already supplies its non-verbatim references positionally
    // and a value match on top of that can only be a coincidental literal (see
    // proseVarsFor in convert.js). Code keeps the full pageVars — marking cannot
    // reach inside a verbatim block.
    proseVars: ctx.proseVars || ctx.pageVars || new Map(),
    // Resolved URL -> the source LINK TARGET that produced it, for targets where
    // an attribute reference is followed by authored text (`…/tree/v{ver}.0/…`,
    // `{page-cloud-console}settings/developer`). Built in convert.js from the
    // page's own source (attrHrefTemplates), so recognising the href is exact
    // string equality rather than the value reverse-map's boundary guess — which
    // cannot work here, since it would have to decide that `.0` continues the
    // URL but not the version.
    hrefVars: ctx.hrefVars || new Map(),
    codeVars: ctx.codeVars || null,
    // The value map for fence lines no template covered: pageVars minus the names
    // the templates already account for (convert.js codeValueVarsFor).
    codeValueVars: ctx.codeValueVars || ctx.pageVars || new Map(),
    // component -> current stable latest version, for floating versionless
    // cross-component xrefs to `/<comp>/latest/` (see floatCrossComponentLatest).
    latestVersions: ctx.latestVersions || {},
    // URL -> output .mdx file (this component+version), for emitting
    // same-version internal links as relative file links (see relativeDocLink).
    urlToRelFile: ctx.urlToRelFile || null,
    // sourceUrl -> the absolute route it redirects to (see retargetRedirect).
    redirectRetargets: ctx.redirectRetargets || null,
    // Image URL -> tree-relative destination, computed by convert.js from the
    // reference graph (lib/image-placement.js). Absent in a bare convertBody
    // call (the selftest), which falls back to the site-absolute src — the site
    // build then rejects it, rather than a wrong path passing silently.
    imagePlacement: ctx.imagePlacement || null,
  }
  collapseSentinels($, $.root()[0], state)
  fixSwallowedBlockTitles($)
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
      // Snapshot-conditional region (mark-conditionals.js): wrap it in an
      // <IfSnapshot> placeholder in EVERY version. The content stays present in
      // all versions' MDX; the component includes it in the built HTML only on
      // the snapshot version (banner 'unreleased') and hides it on releases.
      // That is the whole point of the source `ifdef::snapshot[]`. (A released
      // version whose golden still carries this content — because its branch is
      // wrongly marked `snapshot: true` — will then diverge from its golden and
      // fail Layer 2: a TRUE POSITIVE flagging that source bug, cleared by the
      // source fix.)
      // Both branches of the conditional are marked (mark-conditionals.js) and
      // both become components: the `ifdef` region <IfSnapshot>, the `ifndef`
      // region <IfNotSnapshot>. Which one a given version's golden CONTAINS is
      // decided by Antora — a snapshot render carries the then-branch, a release
      // render the else-branch — so a page normally yields one or the other here.
      const cond = c.data.trim().match(/^hz-(if|ifnot):snapshot:start$/)
      if (cond) {
        const endMark = `hz-${cond[1]}:snapshot:end`
        const inner = []
        let j = i + 1
        while (j < kids.length && !(kids[j].type === 'comment' && kids[j].data.trim() === endMark)) {
          inner.push(kids[j]); j++
        }
        const name = cond[1] === 'if' ? 'hzifsnapshot' : 'hzifnotsnapshot'
        const wrapper = { type: 'tag', name, attribs: {}, children: inner, parent: node }
        for (const n of inner) n.parent = wrapper
        out.push(wrapper)
        i = j
        continue
      }
      continue // stray/other comment: drop (convertChildren ignored these anyway)
    }
    out.push(c)
  }
  node.children = out
  for (const c of out) if (c.type === 'tag' && c.name !== 'hzpartial') collapseSentinels($, c, st)
}

// Repair a source-AsciiDoc mis-render that Asciidoctor bakes into the golden
// HTML: a spurious `+` list-continuation immediately before a `.Block Title`
// where no list is open. Asciidoctor cannot attach the title to anything, so it
// emits the two lines as one literal paragraph (`<p>+\n.Title</p>`) and the
// following code block loses its title. We detect exactly that shape -- a
// paragraph whose text is `+` then a `.Title` line, immediately followed by an
// untitled listing/literal block -- drop the stray paragraph, and re-attach the
// title to the block as Asciidoctor would have with the `+` removed. The block
// then converts through the normal titled-listing path (`title="…"`). Anything
// that does not match this precise signature is left untouched, so a legitimate
// paragraph is never disturbed. See operator scale.adoc (.For Openshift) and
// hazelcast install-hazelcast.adoc (.RPM); a matching source fix is the real
// cure, but frozen versions cannot be re-sourced.
function fixSwallowedBlockTitles ($) {
  $('div.paragraph > p').each((_, p) => {
    const $p = $(p)
    // `+` (its own line) then a block-title line `.` + non-space, nothing else.
    const m = $p.text().trim().match(/^\+\s*\n\s*\.(\S.*)$/)
    if (!m) return
    const $para = $p.parent()
    const $block = $para.next() // next ELEMENT sibling (cheerio skips text nodes)
    if (!$block.is('.listingblock, .literalblock')) return
    if ($block.children('.title').length) return // already titled: not this bug
    const title = m[1].trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    $block.prepend(`<div class="title">${title}</div>`)
    $para.remove()
  })
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
// The single-sourced-link ladder: given the golden's verbatim href, the href we
// resolved, and the link's visible text, return the `<Variable>` (link mode) that
// keeps the destination a REFERENCE — or null when nothing about this link is
// single-sourced. Three rungs, most exact first:
//
//   1. linkVars    — the whole href IS an attribute's value.
//   2. hrefVars    — this href is what one of the page's own link TARGETS resolves
//                    to, so the source template is re-emitted verbatim with its
//                    `{attr}` intact. The only thing that recovers a reference
//                    followed by authored text (`v{ver}.0`), which the value map
//                    must refuse because it cannot tell that `.0` continues the
//                    URL but not the version.
//   3. pageVars    — a value that is a SUBSTRING of the href and/or the label
//                    (cloud's release-notes link is `.../{page-cloud-platform-
//                    version}/...` labelled `Hazelcast Platform {full-version}`).
//
// The HREF and the LABEL are reverse-mapped against DIFFERENT maps, and the
// difference matters. A URL is not flow text, so marking never reaches it and the
// full `pageVars` is the only thing that can: `href` uses that. A label IS flow
// text, so it takes `proseVars` — the same restriction reverseProseVars applies,
// which excludes MARKED attributes because marking already supplies their exact
// positions and anything the value map finds on top of them is a coincidental
// literal. hazelcast's release-notes/releases is the case: `xref:…enterprise.adoc[]`
// takes its label from the TARGET'S DOCTITLE, which happens to read "Enterprise
// Edition Release Notes", and matching on `pageVars` turned that derived title
// into a `{enterprise-product-name}` reference — a link whose text would silently
// change on a product rename, and which refcheck flags as over-variableised.
//
// Shared by the plain `<a>` and by a link WRAPPED IN `<code>`. That second caller
// is why this is a function: the code-wrapped branch used to emit the resolved URL
// directly, so every `link:…/{os-version}/jar[artifact]` in a monospace table
// column baked its version — 14 occurrences over 3 hazelcast pages, invisible to
// fidelity because a baked value renders identically.
function singleSourcedLink (rawHref, href, tokenText, st, { code = false } = {}) {
  const flag = code ? ' code' : ''
  const labelVars = st.proseVars || st.pageVars
  const varName = st.linkVars.get(rawHref)
  if (varName) return `<Variable href=${jsxAttr(`{${varName}}`)} text=${jsxAttr(tokenText)}${flag}/>`
  const hrefTpl = st.hrefVars.get(rawHref)
  if (hrefTpl) {
    return `<Variable href=${jsxAttr(hrefTpl)} text=${jsxAttr(labelTemplate(tokenText, rawHref, hrefTpl, labelVars))}${flag}/>`
  }
  if (st.pageVars && st.pageVars.size && !/[<>]/.test(href)) {
    const { code: hrefTpl2, replaced: hrefRep } = reverseCodeVars(href, st.pageVars)
    const textTpl = labelTemplate(tokenText, rawHref, hrefTpl2, labelVars)
    if (hrefRep || textTpl !== tokenText) return `<Variable href=${jsxAttr(hrefTpl2)} text=${jsxAttr(textTpl)}${flag}/>`
  }
  return null
}

// The `text` of a link-mode <Variable>: the label with its references restored.
//
// An UNLABELLED url macro is the case the value map cannot serve. Asciidoctor
// copies the resolved URL into the visible text, so the label is not flow text --
// it is a SECOND RENDER of the same target, and the href's own template is
// therefore its exact template. Nothing else reaches it: marking skips a BARE_URL
// (the reference renders into the href, so a span there would be malformed), and
// the label's value map is proseVars, which excludes MARKED attributes. That is
// how clients/java@5.5's two javadoc URLs came to print a baked `5.5.0`/`5.5.10`
// next to a correctly-referenced href -- the only two bare-URL labels in the
// corpus, and invisible to fidelity because both render the same string today.
//
// An AUTHORED label is flow text and keeps the value map (proseVars).
//
// The href template must actually CARRY a reference to be worth copying across.
// Without that guard, a bare URL whose href we merely resolved (rawHref !==
// href, nothing reverse-mapped) would hand the label the resolved URL and turn a
// link with no single-sourced part in it into a <Variable> -- which is what the
// callers' `replaced` checks exist to prevent.
const hasAttrRef = (s) => /\{[A-Za-z0-9_][A-Za-z0-9_-]*\}/.test(s)

function labelTemplate (tokenText, rawHref, hrefTpl, labelVars) {
  if (tokenText === rawHref && hasAttrRef(hrefTpl)) return hrefTpl
  return reverseCodeVars(tokenText, labelVars).code
}

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

// Inline code containing a marker span, as JSX: `<code>` with each literal run
// emitted as a JS STRING EXPRESSION and each marker as a <Variable/>. The string
// form matters -- MDX parses the children of a JSX element as markdown, so a bare
// literal would let `_`/`*`/`[` in a filename or command turn into emphasis or a
// link. `{'…'}` is inert.
function jsxCode ($, node) {
  const parts = []
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.type === 'text') { if (c.data) parts.push({ text: c.data }); continue }
      if (c.type !== 'tag') continue
      const nm = markerName(c)
      if (nm) { parts.push({ name: nm }); continue }
      walk(c)
    }
  }
  walk(node)
  const body = parts.map((p) => (p.name
    ? `<Variable name=${jsxAttr(p.name)}/>`
    : `{${JSON.stringify(p.text)}}`)).join('')
  return `<code>${body}</code>`
}

// A non-heading link target. <Anchor> (globally registered, no import) renders the
// same empty `<span id>` a raw span would, and additionally REGISTERS the id via
// Docusaurus's useBrokenLinks().collectAnchor -- which is the only way the
// broken-anchor validation learns an anchor exists. A bare `<span id>` resolves in
// the browser but is invisible to that check, so every link to one was reported by
// `onBrokenAnchors`; with hundreds of anchors that noise would hide a real break.
const anchorJsx = (id) => `<Anchor id=${jsxAttr(id)}/>`

// Every bare anchor (an `<a id>` carrying no href) inside `node`, in document
// order, as <Anchor> elements -- for the callers that flatten an element to its
// text and would otherwise lose them.
//
// An `<a>` with BOTH id and href is deliberately excluded: it is a link, and the
// link paths handle it. Checked rather than assumed -- the golden has 18 of those
// (hz-docs footnote refs) and NONE is nested in a <code>, so no id is lost here.
function anchorsIn ($, node) {
  return $(node).find('a[id]:not([href])').toArray().map((a) => anchorJsx(a.attribs.id)).join('')
}

// Carry a BLOCK's own `id` across as a registered anchor.
//
// AsciiDoc `[[id]]` above a paragraph, table or listing block is a link target
// that is NOT a heading: Asciidoctor puts the id on the block element itself
// (`<div id=… class="paragraph">`, `<table id=…>`, `<div id=… class="listingblock">`),
// and every converter branch below reads the block's CONTENT, so the id was
// dropped and every `<<id>>` pointing at it became a dead anchor -- 12 of them
// across 8 Platform pages, invisible to Layer 1 and 2 (an anchor has no text and
// is not a counted element) and caught only by Layer 3.
//
// Emitted as <Anchor>, not a bare `<span id>`, for the reason that component
// exists: only a registered anchor is visible to Docusaurus's broken-anchor
// validation. Deduped per page -- the same id emitted twice would be a duplicate
// DOM id and a duplicate registration.
function convertBlock ($, node, st, depth) {
  const out = convertBlockInner($, node, st, depth)
  const id = node.attribs && node.attribs.id
  // Headings register their own id, and `preamble` is Asciidoctor's structural
  // wrapper rather than an authored target.
  if (!id || !out.trim() || /^h[1-6]$/.test(node.name) || id === 'preamble') return out
  if (st.blockAnchors.has(id) || out.includes(`<Anchor id="${id}"`)) return out
  st.blockAnchors.add(id)
  return `${anchorJsx(id)}\n\n${out}`
}

function convertBlockInner ($, node, st, depth) {
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

  // Snapshot-conditional region (see collapseSentinels): render its block content
  // inside <IfSnapshot> / <IfNotSnapshot> (both globally registered, no import).
  // Blank-line padded so MDX parses the children as Markdown.
  if (name === 'hzifsnapshot' || name === 'hzifnotsnapshot') {
    const tag = name === 'hzifsnapshot' ? 'IfSnapshot' : 'IfNotSnapshot'
    const inner = convertChildren($, node, st, depth).trim()
    return inner ? `<${tag}>\n\n${inner}\n\n</${tag}>` : ''
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
    const apiRef = swaggerMacro($, node, st)
    if (apiRef) return apiRef
    // A block title on a PARAGRAPH (`.Example query results` above an inline
    // image). Asciidoctor emits it as a <div class="title"> BESIDE the <p>, so
    // reading only the <p> silently dropped it -- 12 occurrences in the live set
    // (management-center tools/sql-browser, clusters/update-config), caught by
    // Layer 1 as a missing prose segment.
    //
    // Emitted as its own paragraph rather than a styled caption, because that is
    // what the reader sees today: the Antora UI's caption rules cover
    // listing/literal/image/admonition/example/open blocks and table captions,
    // and NOTHING selects `.paragraph > .title`, so the live site renders it as
    // an ordinary line of text above the block. A real caption would be an
    // improvement on the golden, which needs a fidelity accept entry, not a
    // silent divergence. Removed from the tree first (as convertAdmonition does)
    // so the no-<p> fallback below cannot emit it twice.
    const titleEl = $(node).children('.title').first()
    const title = titleEl.length ? escapeBlockStart(inline($, titleEl[0], st).trim()) : ''
    titleEl.remove()
    const p = $(node).children('p').first()
    const body = escapeBlockStart(inline($, (p[0] || node), st))
    return title ? `${title}\n\n${body}` : body
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
  // Footnote DEFINITION. Asciidoctor emits the block Antora renders at the foot of
  // the page as
  //   <div id="footnotes"><hr><div class="footnote" id="_footnotedef_1">
  //     <a href="#_footnoteref_1">1</a>. text with <a>links</a></div></div>
  // Its content is INLINE, but `.footnote` matches no block class, so the generic
  // div catch-all below used to send it through convertChildren -- which joins
  // children with a blank line and split one footnote into three paragraphs (the
  // back-link, then a paragraph starting ". The backup count…", which is not a
  // Markdown list marker and so rendered with the stray leading dot, then each
  // link). Render it as the single inline paragraph it is.
  //
  // The id carries the reference target: the footnote REF emits [1](#_footnotedef_1),
  // so without an anchor here that link points at nothing. It is a div, not a
  // heading, so Docusaurus's collectAnchor never sees it -- hence <Anchor>, the
  // same component the ref side already uses for _footnoteref_N.
  if (cls.includes('footnote')) {
    const id = node.attribs && node.attribs.id
    return (id ? anchorJsx(id) : '') + inline($, node, st).trim()
  }

  if (node.attribs && node.attribs.id === 'preamble') return convertChildren($, node, st, depth)
  if (cls.includes('sectionbody') || cls.includes('openblock') || cls.includes('exampleblock') ||
      cls.includes('content') || cls.includes('sidebarblock') || name === 'div') {
    // A block title on an example/open/sidebar block (`.Example JSON-formatted
    // string`). Asciidoctor renders it BESIDE the .content wrapper, so reading
    // only .content dropped it -- sql/working-with-json lost both its captions.
    //
    // The text is taken as rendered, which includes Asciidoctor's own counter
    // ("Example 1. "). That bakes a number the source does not carry, but it is
    // what the page shows and what Layer 1 compares; the alternative is inventing
    // a counter in MDX. Emitted bold rather than plain because the Antora UI DOES
    // style example-block captions (unlike `.paragraph > .title`, which it leaves
    // as body text), so bold is the closer reading -- 2 occurrences corpus-wide.
    const titleEl = $(node).children('.title').first()
    const title = titleEl.length ? `**${escapeBlockStart(inline($, titleEl[0], st).trim())}**` : ''
    titleEl.remove()
    const inner = $(node).children('.content')[0] || node
    const body = convertChildren($, inner, st, depth)
    return title ? `${title}\n\n${body}` : body
  }

  // Unknown element: fall back to a faithful raw-HTML rendering.
  return serializeJsx($, node, st)
}

// The `swagger_ui::URL[]` block macro (hazelcast-docs-tools), which publishes an
// OpenAPI spec and renders a reference for it. The golden render does NOT load
// that extension (see the `extensions:` note in antora/index-playbook.yml -- it
// needs a token for the private product repos), so Asciidoctor leaves the whole
// line as literal paragraph text, which is what this matches. The macro takes no
// attributes, so the brackets are always empty and the target cannot contain
// whitespace.
//
// Emitted as the site's own <ApiReference> (globally registered in
// MDXComponents, so no import). The same declaration is read at build time by
// plugins/openapi-specs, which fetches the spec and stages it as a static
// attachment; the component only resolves the URL it was staged at.
const SWAGGER_MACRO = /^swagger_ui::(\S+)\[\]$/

// The branch in the spec URL is an {attribute} reference in the source
// (`.../blob/{mc-repo-swagger-branch}/...`), and the no-baking rule applies to it
// like any other. It is restored as a LITERAL `{name}` token rather than the
// prose <Variable/> form: `source` is a plain JSX string that both the plugin and
// the component read as text, and a `{name}` inside it is exactly what
// refcheck/lib/mdx-refs.js counts as this page's one reference -- so the census
// balances with no disposition. The whole-token boundary (varTokenRe, the link
// path's) is right here: the value is a complete URL segment.
function swaggerMacro ($, node, st) {
  const p = $(node).children('p').first()
  if (!p.length) return null
  const m = p.text().trim().match(SWAGGER_MACRO)
  if (!m) return null
  const { code: source } = reverseCodeVars(m[1], st.pageVars)
  return `<ApiReference source=${jsxAttr(source)} />`
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
  // An AsciiDoc CHECKLIST (`- [ ]` / `- [*]`) renders as `<ul class="checklist">`
  // whose items open with a checkbox icon. GFM has native task lists, so the
  // marker round-trips as itself -- and it has to: the box is not decoration, it
  // is the item's state, and dropping it turned cloud's migrate-to-cloud
  // checklist (whose own prose says "see the following checklist") into an
  // ordinary bullet list. Nothing catches that -- the golden's <i> holds no text
  // for Layer 1 to miss and Layer 2 counts no icons -- so today every box is
  // unchecked and no information is lost, but the first `- [*]` anyone writes
  // would silently render as done-and-not-done alike.
  const checklist = !ordered && hasClass(listEl, 'checklist')
  items.forEach((li, i) => {
    const marker = ordered ? `${i + 1}.` : (checklist ? `- [${checkedState($, li) ? 'x' : ' '}]` : '-')
    const indent = ' '.repeat(marker.length + 1)
    const blocks = convertListItem($, li, st, depth)
    const text = blocks.filter((b) => b && b.trim()).join('\n\n')
    const itemLines = text.split('\n')
    lines.push(marker + ' ' + (itemLines[0] || ''))
    for (const l of itemLines.slice(1)) lines.push(l === '' ? '' : indent + l)
  })
  return lines.join('\n')
}

// A checklist item's state, from the checkbox glyph Asciidoctor emits:
// `fa-check-square-o` for `[*]`/`[x]`, `fa-square-o` for `[ ]`. The <i> is then
// dropped by the ordinary decorative-icon path, so the box is not emitted twice.
function checkedState ($, li) {
  return $(li).find('i.fa-check-square-o').length > 0
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
  // DIRECT rows of the colist's own table only -- the same guard convertTable
  // needs. A callout description may CONTAIN an admonition, which Asciidoctor
  // renders as a nested <table> whose single row also has two <td>s (icon +
  // content), so a descendant `find('tr')` counted it as another callout and
  // emitted the warning twice: once nested in its real callout, once as a
  // phantom trailing item (maintain-cluster/rolling-upgrades,
  // clusters/phi-accrual-detector).
  const tbl = $(node).children('table').first()
  const rows = [...tbl.children('tbody').children('tr').toArray(), ...tbl.children('tr').toArray()]
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
  // A block title (`.Heap memory limits`) renders as `<div class="title">` at the
  // head of td.content. Map it to Docusaurus's admonition title `:::type[title]`
  // rather than letting it fall through blockOrInline as a plain first paragraph.
  let title = ''
  if (content) {
    const titleEl = $(content).children('.title').first()
    title = titleEl.text().trim()
    titleEl.remove()
  }
  const body = content ? blockOrInline($, content, st, depth) : ''
  const head = title ? `:::${type}[${title}]` : `:::${type}`
  return `${head}\n\n${body.trim()}\n\n:::`
}

// The block-level vocabulary: the tag names and Asciidoctor class names that
// convertBlock dispatches on. Single-sourced here because blockOrInline has to
// ask the same question convertBlock answers -- "is this child a block?" -- and
// a hand-copied second copy of the list is exactly how a block ends up
// flattened into inline text. It happened: `tabset` was missing, so a
// `[tabs]` block inside a TABLE CELL (hazelcast storage/configuring-persistence)
// came out as the tab labels run together followed by multi-line `code spans`,
// which is not even valid MDX. converter/selftest.js asserts convertBlock
// claims every name listed here, so the two cannot drift again.
// The last two are SYNTHETIC, built by collapseSentinels from the golden's
// `<!--hz-if:snapshot:start-->` marker comments rather than present in the HTML.
// They were missing, and the effect was the failure this comment warns about:
// inside an admonition (data-structures/map-config, all live versions) the region
// was not seen as a block, so its `<ul>` was flattened to a line of links run
// together AND the wrapper was dropped entirely -- inlineTag has no case for
// these names, so `default: return kids()` silently discarded the snapshot
// condition, which would have shown snapshot-only content on every release.
// `hzpartial` is the third synthetic name and belongs here on the same argument;
// it is left out only because no golden page in the corpus puts a partial marker
// inside a cell or admonition, so there is nothing to fix and the vocabulary test
// would need per-fixture `partials` wiring to cover it. inlineTag keeps its
// explicit `hzpartial` case as the insurance for that.
const BLOCK_TAGS = ['ul', 'ol', 'table', 'pre', 'details', 'hzifsnapshot', 'hzifnotsnapshot']
const BLOCK_CLASSES = [
  'paragraph', 'ulist', 'olist', 'dlist', 'colist',
  'listingblock', 'literalblock', 'literal', 'admonitionblock', 'imageblock',
  'tabset', 'openblock', 'exampleblock', 'sidebarblock', 'quoteblock', 'verseblock',
  'sect1', 'sect2', 'sect3', 'sect4', 'sect5',
]

const isBlockChild = (c) =>
  c.type === 'tag' && (BLOCK_TAGS.includes(c.name) || classes(c).some((k) => BLOCK_CLASSES.includes(k)))

// A container whose content may be block-level (wrapped in .paragraph/.ulist/...)
// or bare inline text (Asciidoctor emits admonition/cell text without a <p>).
//
// The awkward case is MIXED: loose inline content sitting directly beside block
// children, which Asciidoctor produces for a callout description that starts with
// a sentence and then carries a block —
//   <td>Set to <code>true</code> if the connection is reusable.<div class="paragraph">…
// Handing that to convertChildren converts every child SEPARATELY and joins with
// blank lines, so one sentence became three paragraphs ("Set to" / "true" / "if
// the connection is reusable.") — sql/mapping-to-mongo. Each run of consecutive
// inline nodes is therefore gathered into ONE paragraph first.
function blockOrInline ($, container, st, depth) {
  const kids = container.children || []
  if (!kids.some(isBlockChild)) return inline($, container, st)
  const out = []
  let run = []
  const flush = () => {
    if (!run.length) return
    const text = inlineFrom($, run, st).replace(/\s+/g, ' ').trim()
    if (text) out.push(escapeBlockStart(text))
    run = []
  }
  for (const node of kids) {
    if (!isBlockChild(node)) { run.push(node); continue }
    flush()
    const block = convertBlock($, node, st, depth)
    if (block && block.trim()) out.push(block.trim())
  }
  flush()
  return out.join('\n\n')
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
    const hit = chooseExample(st.examples.get(normalizeCode($(codeEl || pre).text())), st.pageExampleFiles)
    if (hit) return emitExampleCodeBlock($, pre, hit, title, st)
  }
  return preToFence($, pre, title, st)
}

// Match key for code content: strip trailing newlines/blank lines (mirrors
// convert.js normalizeCode and preToFence's trailing-newline trim).
const normalizeCode = (s) => s.replace(/\n+$/, '')

// Choose which example file a matched code block imports.
//
// Content alone cannot always tell: two files can hold byte-identical regions
// (GroupingClusters.java and GroupingClusters2.java both define an identical
// `groupingclusters` tag), and picking the wrong one severs the doc<->source
// link this whole mechanism exists to preserve -- the page would keep rendering
// another file's copy after someone edits the one it actually names. So content
// finds the candidates and the page's OWN include list picks between them.
//
// Falls back to the previous rule (last file in walk order) when the page names
// none of them, which is the operator whole-file behaviour unchanged.
function chooseExample (candidates, pageExampleFiles) {
  if (!candidates || !candidates.length) return null
  const named = pageExampleFiles && pageExampleFiles.size
    ? candidates.filter((c) => pageExampleFiles.has(c.file))
    : []
  const pool = named.length ? named : candidates
  const file = pool[pool.length - 1].file
  return pool.find((c) => c.file === file)
}

// A stable, unique JS identifier for a page's import of one example SLICE. Keyed
// on file + query, not file alone: a page may show several regions of the same
// file (cp-subsystem/management pulls ten tags of CpSubsystemAPI.java), and each
// needs its own binding.
function exampleVar (spec, st) {
  if (st.exampleVars.has(spec)) return st.exampleVars.get(spec)
  let base = 'Ex_' + spec.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  let name = base
  let n = 2
  while (st.usedVarNames.has(name)) name = `${base}_${n++}`
  st.usedVarNames.add(name)
  st.exampleVars.set(spec, name)
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

// The fence language Prism will actually look up. Prism's registry is
// case-sensitive and knows only its own names, so an AsciiDoc `[source,SQL]` or
// `[source,bat]` silently renders UNHIGHLIGHTED -- a regression the fidelity
// harness cannot see, since it compares text and structure, not highlighting.
// Lowercase, then map the two spellings AsciiDoc uses that Prism does not know.
// Deliberately NOT a place to correct source typos (`jave`) or to invent a
// language for a non-language (`output`, `pseudocode`): those render plain, which
// is what they should do, and a silent correction here would hide the next one.
const PRISM_ALIASES = { bat: 'batch', 'c++': 'cpp' }

function normalizeLang (lang) {
  const l = String(lang || '').toLowerCase()
  return PRISM_ALIASES[l] || l
}

function emitExampleCodeBlock ($, pre, hit, title, st) {
  const { file, query, conums } = hit
  const codeEl = $(pre).find('code')[0]
  let lang = ''
  const langSrc = codeEl || pre
  const dataLang = langSrc.attribs && langSrc.attribs['data-lang']
  if (dataLang) lang = dataLang
  else {
    const m = classes(langSrc).find((c) => c.startsWith('language-'))
    if (m) lang = m.slice('language-'.length)
  }
  lang = normalizeLang(lang)
  const spec = file + (query || '')
  const varName = exampleVar(spec, st)
  st.imports.add("import CodeBlock from '@theme/CodeBlock';")
  // Plain import: a scoped webpack rule (example-attributes-plugin) runs the
  // tag-slice loader, the example-attributes loader and raw-loader on files
  // under examples/. The query selects the region (absent = the whole file, the
  // operator case); {attribute} placeholders in the byte-faithful file are then
  // substituted per version at build (no-op for files without placeholders).
  st.imports.add(`import ${varName} from '${examplesRelPath(st.relFile)}/${spec}';`)
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

// The VERBATIM-block boundary, deliberately looser than varTokenRe: the value
// must not be part of a longer NUMBER, but may be glued into a longer
// IDENTIFIER. Verbatim content names things — `hazelcast-management-center-
// 5.11.0.jar`, `…-center:5.11.0` — and the whole-token rule refuses the first of
// those (preceded by `-`, followed by `.`), which is how a fenced reference came
// to bake on 18 MC pages while the `:`/`@`/`=` forms on the same pages survived.
//
// What it must keep refusing is a value that is a SUBSTRING of a longer version:
// `5.6.0` inside `0.3.5.6.0`, or `5.7` inside `v5.7.0` (MC's update-config link,
// where `.0` is authored after the reference and the two really are different
// numbers). So the guard is numeric on both sides — reject a digit neighbour, and
// reject a `.`/`-` that itself sits against a digit — which passes a filename
// suffix (`.jar`) and rejects a version continuation (`.0`) on the same rule.
//
// Not used for hrefs/labels: in a URL the glued form is exactly the ambiguous
// case (see `v5.7.0` above), so the link path stays on varTokenRe.
const varCodeTokenRe = (value) => new RegExp(`(?<!\\d)(?<![\\d][.-])${escapeRe(value)}(?!\\d)(?![.-]\\d)`, 'g')

const pageVarsSorted = (pageVars) => [...pageVars].sort((a, b) => b[0].length - a[0].length)

// Prose: replace a resolved value with a <Variable> (globally registered in
// MDXComponents, so no import). Applied to already-escaped inline text.
function reverseProseVars (text, pageVars) {
  if (!pageVars || !pageVars.size) return text
  let out = text
  for (const [value, name] of pageVarsSorted(pageVars)) out = out.replace(varTokenRe(value), `<Variable name="${name}"/>`)
  return out
}

// A fence's lines, each replaced by the SOURCE line that produced it where the
// page wrote one with an `{attribute}` in it (convert.js buildCodeVars). Exact
// where the value map has to infer, and the only thing that keeps the right NAME
// when several attributes hold one value — see lib/code-templates.js. Runs before
// the value map, and a templated line is not offered to it: the template already
// names every reference on that line.
function applyCodeTemplates (code, codeVars) {
  const none = { code, replaced: false, done: new Set() }
  if (!codeVars) return none
  // Both sides are keyed with trailing whitespace stripped, because Asciidoctor
  // strips it from the render and a source line may still carry it (rtrimLines).
  const key = rtrimLines(code)
  // Whole-block first: a line can be ambiguous on its own where the block is not.
  const whole = codeVars.blocks && codeVars.blocks.get(key)
  if (whole !== undefined) {
    const done = new Set(whole.split('\n').map((_l, i) => i))
    return { code: whole, replaced: true, done }
  }
  if (!codeVars.lines || !codeVars.lines.size) return none
  const done = new Set()
  const lines = key.split('\n').map((line, i) => {
    const tpl = codeVars.lines.get(line)
    if (tpl === undefined) return line
    done.add(i)
    return tpl
  })
  return { code: lines.join('\n'), replaced: done.size > 0, done }
}

// Code: replace a resolved value with the `{name}` placeholder; the swizzled
// CodeBlock resolves it per version when the fence carries the `vars` flag.
// `boundary` selects which of the two matchers applies — verbatim blocks pass
// varCodeTokenRe, the link path leaves it defaulted to the whole-token rule.
// `skipLines` are line indexes a template already handled.
function reverseCodeVars (code, pageVars, boundary = varTokenRe, skipLines = null) {
  if (skipLines && skipLines.size) {
    const lines = code.split('\n')
    let replaced = false
    const out = lines.map((line, i) => {
      if (skipLines.has(i)) return line
      const r = reverseCodeVars(line, pageVars, boundary)
      if (r.replaced) replaced = true
      return r.code
    })
    return { code: out.join('\n'), replaced }
  }
  return reverseCodeVarsAll(code, pageVars, boundary)
}

function reverseCodeVarsAll (code, pageVars, boundary) {
  if (!pageVars || !pageVars.size) return { code, replaced: false }
  let out = code
  let replaced = false
  for (const [value, name] of pageVarsSorted(pageVars)) {
    const next = out.replace(boundary(value), `{${name}}`)
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
  lang = normalizeLang(lang)
  // Asciidoctor callout numbers (conums) render inside the code as
  // `<i class="conum" data-value="N"></i><b>(N)</b>`. Put the native Asciidoctor
  // `<N>` marker back INLINE on its own line (so it stays glued to that line when
  // the code is edited) and flag the fence with a bare `conums`; the swizzled
  // CodeBlock (src/theme/CodeBlock) strips the `<N>` and re-emits prod's circled
  // badge per line. The bare flag leaves every other code block untouched.
  const { text, hasConums } = extractConums($, code || pre)
  // Exact line templates first, then the value reverse-map on the lines they did
  // not cover. Either way the fence carries `vars` and the swizzled CodeBlock
  // resolves the placeholders per version.
  const tpl = applyCodeTemplates(text, st && st.codeVars)
  const { code: varsText, replaced } = reverseCodeVars(tpl.code, st && st.codeValueVars, varCodeTokenRe, tpl.done)
  let flags = ''
  if (title) flags += ` title=${jsxAttr(title)}`
  if (hasConums) flags += ' conums'
  if (replaced || tpl.replaced) flags += ' vars'
  // A flag needs a LANGUAGE in front of it. MDX reads the first token of a fence's
  // info string as the language, so ```` ``` vars ```` makes `vars` the language and
  // leaves the metastring empty — the swizzled CodeBlock then never sees the flag and
  // the placeholders reach the reader as literal `{page-latest-supported-cplusplus-client}`.
  // `text` is the no-highlighting language, which is what a fence with no language
  // renders as anyway, so this changes nothing the reader sees.
  const info = (flags && !lang ? 'text' : lang) + flags
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
  // The alt is Markdown INLINE PROSE (CommonMark parses `![...]` as inline
  // content), so it gets the same escaper as any other prose run rather than an
  // ad-hoc brackets-only pass. `<` is why: hazelcast's
  // install-and-upgrade/upgrade/migration-tool-imdg has `![Migrating 3.12 <-> 5.x]`,
  // and an unescaped `<` opens JSX -- the build failed on it outright.
  return `![${mdEscape(alt)}](${src})`
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

// A link to another page of THIS component+version -> a relative path to the
// target .mdx FILE (e.g. `../get-started/overview.mdx`). Docusaurus resolves
// doc-to-doc file links version-aware, and — unlike an absolute
// `/<comp>/<version>/` route — they survive `docusaurus docs:version`, which
// COPIES the current docs' files into the new version folder (an absolute link
// would stay frozen pointing at the old version). Membership in urlToRelFile IS
// the same-component/same-version test (the map holds only this version's
// pages); a miss means cross-component or explicit cross-version -> caller keeps
// the absolute/floated form. `path` (the resolved pathname, no hash) is looked
// up; the hash rides along on the returned link.
function relativeDocLink (linkPath, hash, st) {
  if (!st.urlToRelFile || !st.relFile || !linkPath) return null
  const target = st.urlToRelFile.get(linkPath) ||
    st.urlToRelFile.get(linkPath.replace(/\/$/, '')) ||
    st.urlToRelFile.get(linkPath + '/')
  if (!target) return null
  let rel = path.posix.relative(path.posix.dirname(st.relFile), target)
  if (!rel.startsWith('.')) rel = './' + rel
  return rel + (hash || '')
}

// A link to a page the migration REDIRECTS away (an orphan triaged `redirect` in
// orphancheck/allowlist.json): point it at the redirect's TARGET, not at the page
// itself, which is never emitted. Without this the link resolves to a .mdx that
// does not exist -- broken, and only a WARNING (onBrokenLinks: 'warn') -- so
// in-site navigation would silently rot while the client redirect sat there
// unused. Retargeting leaves that redirect doing the job only it can: keeping the
// old URL alive for bookmarks and links from outside the site.
//
// TERMINAL, and deliberately so: the target is a pinned human decision, emitted
// as written. It is NOT floated to `/<comp>/latest/` the way an unpinned
// versionless cross-component xref is -- a cross-component target names a version
// in the other component's line on purpose.
//
// Same-component targets still become relative .mdx links (they survive a version
// cut); a cross-component one has no relative form -- a file link cannot cross a
// plugin instance -- so it stays the absolute route. Any `#frag` rides along
// untouched: retargeting is mechanical, and the fragment is the referrer's
// content, not ours to edit.
function retargetRedirect (resolved, st) {
  if (resolved.kind !== 'internal' || !st.redirectRetargets) return null
  const to = st.redirectRetargets.get(resolved.path) ||
    st.redirectRetargets.get(resolved.path.replace(/\/$/, '')) ||
    st.redirectRetargets.get(resolved.path + '/')
  if (!to) return null
  return relativeDocLink(to, resolved.hash, st) || (to + (resolved.hash || ''))
}

// A same-component link that Antora resolved into ANOTHER version, because the
// source wrote a component-QUALIFIED versionless xref: hz-docs'
// `xref:hazelcast:maintain-cluster:rolling-upgrades.adoc` from inside hz-docs, and
// the operator tutorials' `xref:operator:ROOT:get-started.adoc` from inside the
// operator repo. Antora reads the component coordinate as cross-component and
// resolves versionless -> that component's LATEST RELEASE, so every version's copy
// of the page sends the reader out of the version they are reading: the 5.18
// tutorials link into 5.19. Retarget to the same page in the page's OWN version.
//
// A DELIBERATE DIVERGENCE from the golden -- production has the same jump today --
// and one NO GATE CAN SEE: Layer 3 checks that a link resolves, not that it
// resolves where the golden's did, and the link TEXT is unchanged so Layers 1/2
// are blind too. Recorded here because an accept-list entry would never fire.
//
// Three guards keep it off deliberate cross-version pins:
//   - same component only; a genuine cross-component xref is the float's business.
//   - the target must be the component's CURRENT LATEST RELEASE. That is the
//     fingerprint of the versionless resolution -- an author who pins an older
//     version (`xref:5.5@hazelcast:…`) means it, and is left alone.
//   - the page must EXIST at the page's own version (membership in urlToRelFile,
//     which relativeDocLink tests): with nothing to retarget to, the golden's
//     target beats a 404.
function sameComponentOwnVersion (resolved, st) {
  if (!st.seg || st.component == null) return null
  const m = resolved.path.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/)
  if (!m) return null
  const [, comp, ver, rest] = m
  if (comp !== st.component || ver === st.seg) return null
  if (!st.latestVersions || st.latestVersions[comp] !== ver) return null
  return relativeDocLink(`/${comp}/${st.seg}${rest || '/'}`, resolved.hash, st)
}

// The emitted FORM of a resolved internal href: the redirect target if the page
// is redirected away, else a relative .mdx path to this component+version's file
// (which survives a version cut), else the absolute route with a versionless
// cross-component xref floated to `/<comp>/latest/`. Single-sourced because there
// are THREE call sites -- a plain `<a>`, and the one-link and many-link
// `<code><a></code>` branches -- and they DID drift: both code branches resolved
// the href and emitted it raw, so every link with a code label (a `[cols="m,…"]`
// table column wraps its cells in <code>) kept an absolute /<comp>/<version>/
// route and froze on the segment it was converted at.
function docLinkHref (resolved, st) {
  if (resolved.kind !== 'internal') return resolved.href
  return retargetRedirect(resolved, st) ||
    relativeDocLink(resolved.path, resolved.hash, st) ||
    sameComponentOwnVersion(resolved, st) ||
    floatCrossComponentLatest(resolved.href, st)
}

// Heal a `link:`-macro doc reference. Antora only resolves `xref:` to a page URL;
// `link:clc-script.adoc[…]` is treated as a literal link, so the golden carries a
// raw `foo.adoc` (or `.html`) href that 404s in prod AND here. If dropping the
// extension yields a real page in THIS component (present in urlToRelFile), heal
// the resolved ref to that page so it converts to a normal relative .mdx link.
// If it does NOT resolve to a page, leave it untouched — a genuine dead link must
// still fail Layer 3 rather than be silently normalised into a plausible URL.
function healDocRef (resolved, st) {
  if (resolved.kind !== 'internal' || !st.urlToRelFile) return resolved
  const stripped = resolved.path.replace(/\.(adoc|html)$/, '')
  if (stripped === resolved.path) return resolved
  if (st.urlToRelFile.has(stripped) || st.urlToRelFile.has(stripped + '/')) {
    return { ...resolved, path: stripped, href: stripped + (resolved.hash || '') }
  }
  return resolved
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
//
// Versioned components (st.seg set): Antora publishes each version under
// `/<component>/<seg>/…` and images live at the version tree's root
// (`<component>_versioned_docs/version-<seg>/images/`), so the prefix stripped
// here includes the version segment — mirroring extract-images.js's per-version
// destination. Unversioned components (cloud) strip only the component prefix.
// Look a resolved image URL up in this version's placement plan.
//
// A SPLICED conditional branch is converted from another version's golden but
// with this page's context (see withBothConditionalBranches in convert.js), so
// its image URLs carry the DONOR's version segment. Re-point those at this
// version before giving up — the same image, published twice under two segs.
function placementFor (abs, st) {
  if (!st.imagePlacement) return null
  const direct = st.imagePlacement.get(abs)
  if (direct) return direct
  if (!st.component || !st.seg) return null
  const segs = abs.split('/') // ['', component, donorSeg, …]
  if (segs[1] !== st.component) return null
  segs[2] = st.seg
  return st.imagePlacement.get(segs.join('/')) || null
}

// An image reference is RELATIVE to the consuming file, so webpack resolves,
// verifies and content-hashes it (a missing image fails the build). Where the
// file itself lands is not derivable from the image's URL — see
// lib/image-placement.js — so the destination comes from the plan, and this
// only has to make it relative.
function imageSrc (raw, st) {
  const resolved = resolveHref(raw, st.pageUrl)
  if (resolved.kind !== 'internal') return resolved.href
  const abs = resolved.path
  const hash = resolved.hash || ''
  const dest = placementFor(abs, st)
  if (!dest) return abs + hash
  const fromDir = path.posix.dirname(st.relFile || '')
  let rel = path.posix.relative(fromDir === '.' ? '' : fromDir, dest)
  if (!rel.startsWith('.')) rel = './' + rel
  return rel + hash
}

// --- tabs ------------------------------------------------------------------

function convertTabs ($, node, st, depth) {
  st.imports.add("import Tabs from '@theme/Tabs';")
  st.imports.add("import TabItem from '@theme/TabItem';")
  const labelList = $(node).children('.ulist.tabs').find('> ul > li').toArray()
  const panes = $(node).children('.content').children('.tab-pane').toArray()
  const labels = panes.map((pane, i) => {
    const li = labelList[i]
    return li ? $(li).find('p').text().trim() : `Tab ${i + 1}`
  })
  // Values name the axis, not the page, so they are normalised across repos and
  // then decide which tabsets share a selection — see lib/tabs.js.
  const values = normalizeValues(panes.map((pane, i) => {
    const li = labelList[i]
    const anchor = li ? $(li).find('a[id]')[0] : null
    const id = anchor && anchor.attribs.id
    return id ? id.replace(/^tabset\d+_/, '') : slug(labels[i])
  }))
  const items = panes.map((pane, i) =>
    // Convert the whole tab-pane: content is usually wrapped in an .openblock,
    // but Asciidoctor also emits pane-level siblings (e.g. an admonition after
    // the block). Recursing the pane picks those up; the .openblock unwraps
    // itself in convertBlock.
    `<TabItem value=${jsxAttr(values[i])} label=${jsxAttr(labels[i])}>\n\n` +
    `${convertChildren($, pane, st, depth).trim()}\n\n</TabItem>`
  )
  return `<Tabs groupId=${jsxAttr(groupIdFor(values))}>\n${items.join('\n')}\n</Tabs>`
}

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Escape a leading Markdown BLOCK marker on paragraph text so prose that happens
// to begin with `+ `/`- `/`* `/`> `/`# `/`1. ` is not reparsed as a list item,
// blockquote, or heading. Antora renders such text literally (e.g. scale.adoc's
// `+\n.For Openshift` malformed continuation -> a literal paragraph); MDX would
// otherwise eat the marker and synthesize a spurious list item. The trailing
// whitespace guard keeps `-5`, `*emphasis*`, `#hashtag` untouched.
// A marker needs no trailing content to be a marker: CommonMark reads a line
// holding ONLY `+`, `-`, `*`, `>`, `#` or `1.` as an EMPTY construct of that kind
// -- an empty list item, blockquote or `<h1>` -- so requiring whitespace after it
// let every bare one through. That is not hypothetical authoring: hz-docs has four
// pages where an author wrote a list-continuation `+` after a blank line had
// already ended the list, so Asciidoctor renders a literal `<p>+</p>` and our
// unescaped copy became a phantom empty list item (`listItems` +1) with the `+`
// itself swallowed as the bullet (`L1 - "+"`). `$` therefore stands in for the
// trailing whitespace, and the escaped forms all render as the literal character
// (verified through this site's own @mdx-js/mdx).
function escapeBlockStart (s) {
  return s
    .replace(/^(\s*)([-+*>])(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)(\d+)([.)])(\s|$)/, '$1$2\\$3$4')
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
  return htmlTable($, table, headRows, bodyRows, st)
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
  const headCells = $(headRow).children('th,td').toArray()
  const head = headCells.map((c) => cellInline($, c, st))
  const sep = headCells.map((c, i) => alignSep(columnAlign($, c, bodyRows, i)))
  const rows = bodyRows.map((tr) =>
    $(tr).children('th,td').toArray().map((c) => cellInline($, c, st)))
  const fmt = (cols) => '| ' + cols.join(' | ') + ' |'
  return [fmt(head), fmt(sep), ...rows.map(fmt)].join('\n')
}

// Column alignment from a `[cols=…]` spec. `^15%` (centre) and `>15%` (right)
// reach the golden as `halign-center` / `halign-right` on every cell of the
// column; GFM expresses the same thing in the delimiter row, so it round-trips.
// Worth carrying: management-center's feature matrix centres its two ✓/✗ columns
// deliberately, and neither Layer 1 (text only) nor Layer 2 (element counts) can
// see alignment, so dropping it was silent.
//
// Read from the FIRST BODY cell of the column, falling back to the header: a
// `[cols=…]` spec applies per column, but an individual cell can override it
// (`[align=left]` in a header, as that same table does), and it is the body cells
// that carry the column's own setting.
function columnAlign ($, headCell, bodyRows, i) {
  const first = bodyRows.length ? $(bodyRows[0]).children('th,td').toArray()[i] : null
  for (const cell of [first, headCell]) {
    if (!cell) continue
    const cls = classes(cell)
    if (cls.includes('halign-center')) return 'center'
    if (cls.includes('halign-right')) return 'right'
    if (cls.includes('halign-left')) return 'left'
  }
  return null
}

// GFM delimiter for an alignment. `left` is emitted as a bare `---`, not `:---`:
// left IS the default, so the two render identically and the bare form keeps the
// output unchanged for every table that does not actually set an alignment.
const alignSep = (align) =>
  align === 'center' ? ':---:' : align === 'right' ? '---:' : '---'

// A literal `|` in a GFM cell ends the cell. It has to be escaped even inside a
// code span: the table row is split on unescaped pipes BEFORE inline parsing, so
// `` `SUM(TINYINT | SMALLINT)` `` silently becomes three columns and the row's
// remaining cells shift left. Layer 2 counts rows, not columns, so only Layer 1
// sees it -- as mangled prose (sql/functions-and-operators had three such cells).
const escapeCellPipes = (s) => s.replace(/(?<!\\)\|/g, '\\|')

function cellInline ($, cell, st) {
  // A single-line literal (`[cols="l"]`) cell is inline monospace.
  const lit = literalInlineCell($, cell)
  if (lit != null) return escapeCellPipes(inlineCode(lit))
  // Simple cell: unwrap the .content/.paragraph/<p> and render inline; pipes and
  // newlines must not break the row.
  const inner = $(cell).find('p').first()[0] || cell
  return escapeCellPipes(inline($, inner, st, { cell: true }).replace(/\s*\n\s*/g, ' ').trim())
}

// A clean semantic <table> with Markdown cell bodies. Structural tags sit at
// column 0 (indenting a closing tag after a list breaks the MDX parser), and a
// cell whose Markdown spans lines is blank-line padded so MDX reads the body as
// Markdown (lists, admonitions, paragraphs) rather than raw text.
// The author's column proportions, carried across as a <colgroup>. Asciidoctor
// turns a `[cols="1a,1a,1m,2a"]` spec into <col style="width: 20%;"> ... and the
// Antora UI leaves `table-layout: fixed` COMMENTED OUT, so those percentages are
// the only thing holding the columns in place on the current site.
//
// Dropping them (as "presentational") left every column sized purely by its
// content, which is stable until the content CHANGES SIZE -- so on a table whose
// cells hold tab sets, switching XML/YAML re-flowed the whole table under the
// reader. 321 tables in Platform alone carried a colgroup and none survived.
// Invisible to all three fidelity layers, which compare text and structure but
// not column geometry.
//
// Emitted as JSX (`style={{width:'20%'}}`), since MDX needs an object, not a CSS
// string. A colgroup whose cols carry no width is skipped: it says nothing.
function colgroupJsx ($, table) {
  const cols = $(table).children('colgroup').first().children('col').toArray()
  if (!cols.length) return null
  const widths = cols.map((c) => {
    const m = /width:\s*([\d.]+%)/.exec((c.attribs && c.attribs.style) || '')
    return m ? m[1] : null
  })
  if (!widths.some(Boolean)) return null
  return '<colgroup>\n' +
    widths.map((w) => (w ? `<col style={{width:'${w}'}}/>` : '<col/>')).join('\n') +
    '\n</colgroup>'
}

function htmlTable ($, table, headRows, bodyRows, st) {
  const out = ['<table>']
  const cg = colgroupJsx($, table)
  if (cg) out.push(cg)
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
  // escapeBlockStart, or a cell paragraph the author began with ` - ` becomes a
  // real Markdown list: the hyphen turns into a bullet and stops being TEXT, so
  // the row reads differently and the page gains a list item that the golden does
  // not have (spring/hazelcast-spring-session's flushMode and saveMode cells,
  // where the author hand-typed a two-line pseudo-list inside one paragraph).
  // Each paragraph is wrapped in an explicit `<p>`, because a blank line is NOT
  // enough to keep two of them apart. MDX renders a block whose whole content is
  // one JSX element as that element BARE -- no paragraph around it -- so a cell
  // holding two `<Variable/>` links emitted `<td><a…/><a…/></td>` and the reader
  // saw `hazelcast-default.xmlhazelcast-default.yaml` run together
  // (configuration/configuring-declaratively, 4 cells x 3 released versions; 5.8
  // escapes it only because its ifdef branch has no {os-version} to reference, so
  // the links stay Markdown and Markdown DOES get a paragraph). The explicit tag
  // is also what the golden has -- Asciidoctor emits `<p class="tableblock">` per
  // paragraph -- and it costs nothing where MDX would have wrapped it anyway:
  // there is no `p` override in the component map, and inline Markdown inside a
  // raw `<p>` is still parsed (`**b**`, `[l](u)` and a hard break all survive).
  //
  // Only this branch: every child here IS a `<p>`. The `.content` branch above
  // holds arbitrary blocks (lists, fences, admonitions), which must not be put
  // inside a paragraph.
  if (ps.length > 1) {
    return ps.map((p) => escapeBlockStart(inline($, p, st).trim())).filter(Boolean)
      .map((md) => `<p>${md}</p>`).join('\n\n')
  }
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
  const prose = (text) => {
    const esc = opt.cell ? mdEscapeCell(text) : mdEscape(text)
    // Autolink-breaking goes LAST, and by position (just after the scheme's
    // colon) rather than by matching the whole URL, so it is unaffected by the
    // backslashes mdEscape adds inside a path and by a <Variable/> that
    // reverseProseVars may have put in one.
    const withVars = st && st.proseVars ? reverseProseVars(esc, st.proseVars) : esc
    return opt.inLink ? withVars : breakAutolinks(withVars)
  }
  // A PLACEHOLDER URL is normalised to inline code (see mdx.js): pulled out
  // BEFORE prose escaping, because a code span must carry the raw characters --
  // mdEscape's backslashes would render literally inside backticks.
  let out = ''
  let last = 0
  PROSE_URL.lastIndex = 0
  for (let m; (m = PROSE_URL.exec(collapsed)) !== null;) {
    if (!isPlaceholderUrl(m[0])) continue
    out += prose(collapsed.slice(last, m.index)) + inlineCode(m[0])
    last = m.index + m[0].length
  }
  return out + prose(collapsed.slice(last))
}

// Wrap emphasis, moving any leading/trailing whitespace OUTSIDE the delimiters.
// CommonMark requires the closing run to be preceded by a non-space character, so
// `**BETWEEN: **` -- exactly what `<strong>BETWEEN: </strong>` produces, and
// query/predicate-overview has several -- is not emphasis at all: the asterisks
// render literally. Same text and spacing, but it actually parses.
function emphasis (text, mark) {
  const [, lead, core, trail] = String(text).match(/^(\s*)([\s\S]*?)(\s*)$/)
  if (!core) return ''
  return `${lead}${mark}${core}${mark}${trail}`
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
      return emphasis(kids(), '**')
    }
    case 'em': return emphasis(kids(), '*')
    case 'i':
      // Asciidoctor renders emphasis as <em>; an <i> is a font ICON. Most are
      // chrome -- the admonition glyph, the external-link marker -- and are
      // dropped, because Docusaurus draws its own and treating one as italic
      // emits an empty `**`/`*`.
      //
      // An icon that is CONTENT is handled one level up, on its `span.icon`
      // parent (see the 'span' case): Asciidoctor wraps `icon:x[role=y]` in
      // `<span class="icon y">`, and nothing else here wears that class. So by
      // the time we reach a bare <i>, the icon really is decoration.
      if (cls.some((c) => c === 'fa' || c.startsWith('fa-') || c.startsWith('icon-'))) return ''
      return emphasis(kids(), '*')
    case 'code': {
      // A monospaced cross-reference renders as `<code><a href>Type</a></code>`
      // (api-ref's field-type columns). Markdown cannot hold a link INSIDE inline
      // code, but it can hold code inside a link LABEL, which is visually
      // identical and keeps the link. Only the single-link case (the CRD pattern)
      // is handled; anything else stays plain inline code.
      // SEVERAL links inside one <code> -- `<code><a>Sources.cache</a>, <a>Sources
      // .remoteCache</a></code>`, which integrate/connectors uses throughout its
      // connector tables. Taking the first link and labelling it with the whole
      // code text merged two destinations into one and silently dropped the
      // second (9 links lost on that page alone). Convert each child instead:
      // every link keeps its own href with a code label, and the text between
      // them (the `, `) stays as text.
      const anchors = $(node).find('a[href]').toArray()
      if (anchors.length > 1 && anchors.every((el) => {
        const { kind, href } = resolveHref(el.attribs.href, st.pageUrl)
        return kind !== 'empty' && kind !== 'malformed' && !/[<>]/.test(href) && !isPlaceholderUrl(el.attribs.href)
      })) {
        return (node.children || []).map((c) => {
          if (c.type === 'text') return mdEscape(c.data)
          if (c.type !== 'tag') return ''
          if (c.name === 'a' && c.attribs && c.attribs.href) {
            const href = docLinkHref(resolveHref(c.attribs.href, st.pageUrl), st)
            const single = singleSourcedLink(c.attribs.href, href, markerText($, c), st, { code: true })
            if (single) return single
            return `[${inlineCode($(c).text())}](${/[()\s]/.test(href) ? `<${href}>` : href})`
          }
          return inlineCode($(c).text())
        }).join('')
      }
      const a = $(node).find('a[href]')[0]
      if (a && a.attribs && a.attribs.href) {
        const resolved = resolveHref(a.attribs.href, st.pageUrl)
        const { kind, href } = resolved
        // A bare-URL autolink inside code (`<code><a class="bare" href=…>`) whose
        // URL carries literal angle brackets is a placeholder shown AS code, not
        // a real link — and its invalid URL fails Docusaurus compile. Keep it as
        // inline code with no link. Genuine cross-references (api-ref's `#Type`)
        // become a link whose label is code (Markdown allows code in a label).
        // A PLACEHOLDER URL is not a destination (see mdx.js isPlaceholderUrl), so
        // it keeps the code and loses the link -- the same treatment the
        // angle-bracket pseudo-URL below already gets, and what the 6 correctly
        // authored occurrences in the corpus (`\http://…` in backticks) render as.
        if (kind !== 'empty' && kind !== 'malformed' && !/[<>]/.test(href) &&
            !isPlaceholderUrl(a.attribs.href)) {
          // Same relative-link ladder as the plain `<a>` case below, and for the
          // same reason: a link whose LABEL is code is still a link, so a
          // same-component same-version target has to become a relative .mdx path
          // that survives a version cut. Without it a `[cols="m,…"]` column --
          // Asciidoctor wraps a monospace cell's content in <code>, so the anchor
          // arrives NESTED and takes this branch instead of that one -- kept the
          // absolute /<comp>/<version>/ route and froze on the segment it was
          // converted at.
          const linkHref = docLinkHref(resolved, st)
          // A single-sourced destination must stay a reference here too, with
          // `code` so <Variable> renders the label as monospace — the alternative
          // (a Markdown link with a code label) has nowhere to put an unresolved
          // `{attr}` in its href.
          const single = singleSourcedLink(a.attribs.href, linkHref, markerText($, node), st, { code: true })
          if (single) return single
          const label = inlineCode($(node).text())
          return `[${label}](${/[()\s]/.test(linkHref) ? `<${linkHref}>` : linkHref})`
        }
      }
      // A marked {attr} reference inside inline code. Markdown backticks cannot
      // hold it: a code span is literal, so neither a component nor a `{name}`
      // token survives there (and the `vars` flag is a FENCE info-string flag,
      // which a code span has no room for). JSX <code> can, so emit that
      // instead -- visually identical, and the reference stays single-sourced.
      if ($(node).find('span[class^="hz-attr-"]').length) return jsxCode($, node)
      // A bare inline anchor NESTED IN the code span
      // (`<code><a id="hazelcast-mc-http-port"></a>hazelcast.mc.http.port</code>`,
      // AsciiDoc `|[[id]]name` in a table cell). inlineCode() takes the element's
      // TEXT, so the anchor was silently dropped -- 105 of them on
      // management-center deploy-manage/system-properties alone, which killed 5
      // same-page links and 32 inbound deep links per version.
      //
      // Emitted BEFORE the code span rather than inside it: an empty anchor is
      // zero-width either way, so the scroll target is the same, and keeping the
      // content as a Markdown code span avoids turning every such cell into JSX.
      return anchorsIn($, node) + inlineCode($(node).text())
    }
    case 'br': return '<br/>'
    case 'a': {
      const id = node.attribs && node.attribs.id
      // Preserve a bare inline anchor target (`<a id="step-5"></a>`) so `#step-5`
      // links still resolve; without this the anchor is dropped and Layer 3
      // reports dead-anchor-self.
      const anchorEl = id ? anchorJsx(id) : ''
      if (cls.includes('anchor')) return opt.skipAnchors ? '' : anchorEl // heading self-link: no text
      // `inLink`: inside a `[…]` label no autolink can form, so the
      // autolink-breaker must stay out -- otherwise a bare-URL label (the golden's
      // own autolink text, `[https://x](https://x)`) gets a pointless `{/**/}`.
      const label = inlineFrom($, node.children, st, { ...opt, inLink: true }).trim()
      const rawHref = (node.attribs && node.attribs.href) || ''
      // `rawHref` stays the golden's verbatim href -- it is the KEY into linkVars
      // and hrefVars, which are built from the resolved golden URLs. Only the
      // href we RESOLVE is repaired (see repairApiDeepLink).
      const resolved = healDocRef(resolveHref(repairApiDeepLink(rawHref), st.pageUrl), st)
      const kind = resolved.kind
      // Internal link: prefer a relative link to the target .mdx of THIS
      // component+version (survives version cuts); otherwise keep the absolute
      // path, floating a versionless cross-component xref to `/<comp>/latest/`.
      const href = docLinkHref(resolved, st)
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
      const single = singleSourcedLink(rawHref, href, tokenText, st)
      if (single) return anchorEl + single
      // A href with literal angle brackets (a placeholder pseudo-URL like
      // `http://<mc-ip-address>:8080`) cannot be a link in Docusaurus: it fails
      // URL validation at compile time in EVERY form (Markdown link and raw
      // <a> alike). Keep the visible text (jsxText encodes the brackets) and drop
      // the un-followable link wrapper — the only form that compiles.
      if (/[<>]/.test(href)) return anchorEl + label
      // Asciidoctor autolinks a bare `http://…` in prose, including addresses the
      // reader is meant to TYPE (`https://example.com`, `http://localhost:8080`).
      // Those are not navigable destinations, so we render them as inline code and
      // drop the link -- normalising the five ways the corpus authors this to the
      // one the careful pages already use. A DELIBERATE divergence from the golden
      // (which links them), recorded in fidelity/accepted.json. Only a bare
      // autolink qualifies: a placeholder URL carrying a real label is left alone,
      // since dropping the link would lose the label's meaning.
      if (isPlaceholderUrl(rawHref) && $(node).text().trim() === rawHref) {
        return anchorEl + inlineCode(rawHref)
      }
      // A marked {attr} reference in the label became a <Variable/> in `label`
      // (via the span case). MDX cannot parse a component inside a `[…]` link
      // label, so emit a raw <a> with the component in the children. A raw <a> is
      // NOT run through Docusaurus's Markdown link resolver, so the relative .mdx
      // `href` (which only resolves in `[](…)` syntax) would be left verbatim and
      // 404. Use the site-absolute resolved URL instead — extensionless, routes
      // correctly under baseUrl '/', and is the exact URL Layer 3 checks.
      if (label.includes('<Variable')) {
        const absHref = kind === 'internal' ? floatCrossComponentLatest(resolved.href, st) : resolved.href
        return anchorEl + `<a href=${jsxAttr(absHref)}>${label}</a>`
      }
      // Only an UNESCAPED `]` needs escaping. The label has already been through
      // mdEscape, which escapes both brackets, so a blanket replace turns its
      // `\]` into `\\]` -- an escaped BACKSLASH followed by a live `]`, which
      // ends the label early and leaves the link rendering as literal source.
      // Real case: 5.3 data-structures/priority-queue says `<<configuring-queue>>`
      // against an anchor that is not on the page, and Asciidoctor renders an
      // unresolved internal xref with the id in square brackets as its LABEL --
      // `<a href="#configuring-queue">[configuring-queue]</a>`. Same lookbehind
      // idiom as escapeCellPipes, and for the same reason.
      const safeLabel = label.replace(/(?<!\\)\]/g, '\\]')
      const safeHref = /[()\s]/.test(href) ? `<${href}>` : href
      return anchorEl + `[${safeLabel}](${safeHref})`
    }
    case 'span': {
      const attr = markerName(node)
      if (attr) return `<Variable name=${jsxAttr(attr)}/>` // marked {attr} reference -> <Variable>
      // A CONTENT icon: `icon:check-circle[role=success]` -> `<span class="icon
      // success"><i class="fa fa-check-circle"></i></span>`. The role is the
      // meaning (success = supported, error = not), and on management-center's
      // feature matrix these ticks and crosses are the table's only data -- so
      // they must survive, unlike the decorative <i> handled above. Emitted as
      // <Icon> (globally registered) rather than a ✓/✗ character because the
      // golden's <i> carries NO text: a character would ADD text the source never
      // rendered and fail the Layer-1 diff.
      const iconRole = cls.includes('icon') ? cls.find((c) => ICON_ROLES.has(c)) : null
      if (iconRole) return `<Icon role=${jsxAttr(iconRole)}/>`
      if (cls.includes('image')) {
        const img = $(node).find('img')[0]
        return img ? imageMd($, img, st) : ''
      }
      return kids()
    }
    case 'img': return imageMd($, node, st)
    case 'sup': case 'sub': case 'kbd': case 'mark': case 'u': case 'small': case 'del': case 'ins':
      // Footnote REFERENCE. Asciidoctor emits
      //   <sup class="footnote" id="_footnote_NAME">[<a id="_footnoteref_N"
      //     href="#_footnotedef_N">N</a>]</sup>
      // The square brackets are literal TEXT either side of the link, so running
      // the children through the Markdown inline path made them `\[`/`\]` and
      // split the link off as a separate Markdown link plus a bare <Anchor> --
      // correct, but unreadable in the source. Everything here is already JSX, so
      // emit the whole thing as JSX and no escaping is needed. Both ids become
      // <Anchor>s: `_footnoteref_N` is what the definition links back to, and the
      // sup's own `_footnote_NAME` is the anchor Asciidoctor derives from the
      // footnote's name -- neither is a heading, so collectAnchor never sees them.
      // `footnote` is the first reference (it carries the ids); `footnoteref` is a
      // RE-reference to the same footnote, from Asciidoctor's `footnote:name[]`
      // shorthand -- same shape, no ids, and it must not be left behind escaped.
      if (name === 'sup' && (cls.includes('footnote') || cls.includes('footnoteref'))) {
        const a = $(node).find('a[href]')[0]
        if (a) {
          const supId = node.attribs && node.attribs.id
          return `<sup>${supId ? anchorJsx(supId) : ''}${a.attribs.id ? anchorJsx(a.attribs.id) : ''}` +
            `[<a href=${jsxAttr(a.attribs.href)}>${mdEscape($(a).text().trim())}</a>]</sup>`
        }
      }
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

module.exports = {
  convertBody, serializeJsx, ADMONITION_TYPES, BLOCK_TAGS, BLOCK_CLASSES,
  // Exported for the CommonMark oracle in converter/selftest.js: the requirement
  // ("an escaped block renders as its own literal text and nothing else") is only
  // checkable against a real parser.
  escapeBlockStart,
  // BADGE_CLASSES is exported for refcheck/lib/census-ledger.js: the gate has to
  // recognise a badge label as the same thing the converter turns into <Badge/>,
  // or the two disagree about whether a reference was lost. One definition.
  BADGE_CLASSES,
}
