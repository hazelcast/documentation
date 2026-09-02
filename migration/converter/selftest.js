'use strict'

// Unit self-test for the converter's pure text primitives. Tests state the
// REQUIREMENT, checked against an independent oracle, not the current output:
//   1. mdx.js escapers -- the requirement is "escaping never changes what the
//      reader sees, it only stops MDX reinterpreting punctuation." So we render
//      the escaped output through a real CommonMark parser (micromark) and assert
//      the rendered text/code equals the input verbatim. A bug that mis-escapes
//      shows up as a rendering that differs from the input -- caught regardless
//      of how the escaper is written.
//   2. link classifiers -- converter/lib/links.js (emits the href) and
//      fidelity/lib/links.js (checks it) MUST agree on external/anchor/internal
//      and the resolved path, or a link the converter emits fails its own Layer-3
//      check. A differential test: two independent implementations must agree.
//
// All pure. Run: node converter/selftest.js

const assert = require('node:assert')
const { micromark } = require('micromark')
const cheerio = require('cheerio')
const { gfm } = require('micromark-extension-gfm')
const { gfmHtml } = require('micromark-extension-gfm')

const { mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode } = require('./lib/mdx')
const { resolveHref, attrHrefTemplates, unmangleSubscripts, repairApiDeepLink } = require('./lib/links')
const { convertBody, BLOCK_TAGS, BLOCK_CLASSES, escapeBlockStart } = require('./lib/html-to-mdx')
const { classifyHref } = require('../fidelity/lib/links')
const { collectOccurrences, decide, slugFor, componentNameFor, parseId, consumerAttrs } = require('./lib/partials')
const { normalizeValues, groupIdFor } = require('./lib/tabs')
const { attrCodeTemplates, buildCodeTemplates } = require('./lib/code-templates')
const substituteAttrs = require('../../plugins/lib/substitute-attributes')
const { parseNav, buildPlan, injectNavEntries, resolveNavIncludes, parseTarget, pageKey, folderName } = require('./lib/nav')
const {
  wrapRefs, wrappableRefs, hasSentinelResidue, hasAttrSpanLeak, stripAttrSpans,
} = require('../antora-extension/mark-attributes')
const substitute = require('../../plugins/lib/substitute-attributes')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// Oracles. renderedText: the visible text after a real CommonMark render.
// decodeEntities: the text an HTML/JSX entity string decodes to. renderedCode:
// the code element(s) a Markdown render produces and their verbatim content.
const renderedText = (md) => cheerio.load(micromark(md)).root().text().replace(/\n+$/, '')
const decodeEntities = (html) => cheerio.load(`<x>${html}</x>`)('x').text()
const renderedCode = (md) => {
  const $ = cheerio.load(micromark(md))
  return { count: $('code').length, text: $('code').first().text().replace(/\n$/, '') }
}

// --- mdEscape: rendering the escaped prose reproduces the input --------------
// The requirement (mdx.js header): escaping is fidelity-safe -- the rendered
// text is identical to the input, it only stops MDX reinterpreting punctuation.
// Verified against a real CommonMark parser over adversarial inputs, so ANY
// mis-escape (a `*` still read as emphasis, a `[` still opening a link) surfaces
// as a render that diverges from the input.
{
  const adversarial = [
    'a*b_c', 'x[y](z)', 'a`b`c', '# not a heading', 'p|q', 'a<b>c',
    'use {x} and #h', 'back\\slash', 'a * b _ c', 'all: *_[]`#|<>{}\\',
  ]
  for (const s of adversarial) {
    assert.strictEqual(renderedText(mdEscape(s)), s, `mdEscape keeps rendered text == input for ${JSON.stringify(s)}`)
  }
  ok('mdEscape: escaped prose renders back to the input verbatim (CommonMark oracle)')

  // Typographic folding is itself a fidelity requirement (Layer-1 folds the same
  // glyphs, so the compare stays equal): curly quotes / nbsp -> ASCII.
  assert.strictEqual(renderedText(mdEscape('“x” a b')), '"x" a b', 'curly quotes + nbsp folded to ASCII')
  ok('mdEscape: folds the typographic glyphs Asciidoctor introduces')

  // --- escapeBlockStart: a block's first character cannot start a construct ---
  // Same shape of requirement, one level up: whatever a converted block STARTS
  // with, the render must be that literal text and nothing structural. Stated
  // against the parser, so it holds for markers with content after them AND for a
  // marker standing alone -- which CommonMark reads as an EMPTY list item /
  // blockquote / heading, and which the `(\s)` requirement used to let through.
  const blockStarts = [
    '+', '-', '*', '>', '#', '###', '1.', '2)',                    // bare markers
    '+ then text', '- a', '* a', '> a', '# a', '1. a', '12) a',    // marker + content
    '+------------+', '--force', '*emphasis*', '2.5 seconds',      // not markers at all
  ]
  // The real pipeline: inline escaping first (inline() -> escapeInlineText ->
  // mdEscape), then the block-start guard on the result. Composing both is what
  // makes the assertion about the converter rather than about one helper --
  // `*emphasis*` is mdEscape's to neutralise, a bare `*` is this one's.
  for (const s of blockStarts) {
    const md = escapeBlockStart(mdEscape(s))
    assert.strictEqual(renderedText(md), s,
      `escapeBlockStart keeps rendered text == input for ${JSON.stringify(s)} (got ${JSON.stringify(md)})`)
    const $ = cheerio.load(micromark(md))
    assert.strictEqual($('li, blockquote, h1, h2, h3, h4, h5, h6').length, 0,
      `escapeBlockStart introduces no list/quote/heading for ${JSON.stringify(s)} (got ${JSON.stringify(md)})`)
  }
  ok('escapeBlockStart: a block-leading marker stays literal, bare or not (CommonMark oracle)')

  // mdEscapeCell must additionally survive a GFM table cell -- the requirement is
  // that a literal pipe cannot split the cell, i.e. it is escaped.
  assert.strictEqual(mdEscapeCell, mdEscape, 'mdEscapeCell is mdEscape (pipe is in the prose set)')
  assert.strictEqual(renderedText(mdEscapeCell('a|b')), 'a|b', 'a literal pipe renders as text, not a column break')
  ok('mdEscapeCell: a literal pipe is preserved for GFM cells')
}

// --- jsxText / jsxAttr: entity-encode the JSX-hostile characters -------------
// Requirement: the characters that break JSX (< > { } &) must not appear RAW,
// and decoding the entities must reproduce the input unchanged.
{
  for (const s of ['a<b>{c}&d', 'A & B', 'plain text', '{expr} <Tag/>']) {
    const out = jsxText(s)
    assert(!/[<>{}]/.test(out) && !/&(?!(amp|lt|gt|#\d+);)/.test(out), `no raw JSX-hostile char in ${JSON.stringify(s)}`)
    assert.strictEqual(decodeEntities(out), s, `jsxText decodes back to input for ${JSON.stringify(s)}`)
  }
  ok('jsxText: entifies < > { } & and nothing else (decodes to the input)')

  // In a double-quoted JSX attribute only " (the delimiter) and & (entity start)
  // are hostile; <, >, { } are literal, so the oracle decodes ONLY those two.
  const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  for (const s of ['plain', 'say "hi" & bye', 'a<b>{x}', 'tag </close>']) {
    const out = jsxAttr(s)
    assert(out.startsWith('"') && out.endsWith('"'), 'wrapped in double quotes')
    const inner = out.slice(1, -1)
    assert(!inner.includes('"'), 'no raw double-quote closes the attribute early')
    assert(!/&(?!(amp|quot|#\d+);)/.test(inner), 'every & is an entity, not a bare ampersand')
    assert.strictEqual(decodeAttr(inner), s, `jsxAttr decodes back to input for ${JSON.stringify(s)}`)
  }
  ok('jsxAttr: double-quoted, escapes " and & (only), decodes to the input')
}

// --- inlineCode / fencedCode: content preserved, fence never split -----------
// Requirement: the content is verbatim and the backtick fence is never
// terminated early. Verified by rendering and asserting exactly one code element
// whose text equals the content -- including when the content itself holds
// backtick runs that a too-short fence would break on.
{
  for (const s of ['a', 'a`b', '`x`', 'plain code', 'tick ``` inside']) {
    const r = renderedCode(inlineCode(s))
    assert.strictEqual(r.count, 1, `inlineCode yields one code span for ${JSON.stringify(s)}`)
    assert.strictEqual(r.text, s, `inlineCode preserves content verbatim for ${JSON.stringify(s)}`)
  }
  ok('inlineCode: one code span, content verbatim, fence not split (CommonMark oracle)')

  // ...and the whitespace SEPARATING the span from its neighbours survives the
  // end-of-line cleanup inline() applies to the assembled text. The requirement is
  // about the reader: whitespace at the EDGE of the content is what separates the
  // code from the words around it, so it must still be there after rendering.
  // The span is placed against bare `x`/`y` with no space of our own -- any gap in
  // the render can only have come from the content. Asserted through the real
  // pipeline order (build the span, then inline()'s `[ \t]+\n` -> `\n` cleanup,
  // then render), because that interaction is what dropped a space on
  // serialization/schema-evolution-full: a <code> whose text STARTED with a soft
  // line break, courtesy of Asciidoctor's repair of its own malformed overlap.
  const afterInline = (md) => md.replace(/[ \t]+\n/g, '\n')
  for (const [content, why] of [
    ['\n`COUNT(currency)', 'a newline at the START of the content'],
    ['trailing\n', 'a newline at the END of the content'],
    ['\nboth\n', 'newlines at both ends'],
    [' leading', 'a leading space'],
    ['trailing ', 'a trailing space'],
  ]) {
    const rendered = renderedText('x' + afterInline(inlineCode(content)) + 'y')
    if (/^\s/.test(content)) {
      assert.match(rendered, /^x\s/, `leading whitespace separates the code from the text before it: ${why}`)
    }
    if (/\s$/.test(content)) {
      assert.match(rendered, /\sy$/, `trailing whitespace separates the code from the text after it: ${why}`)
    }
  }
  // The converse: content with no edge whitespace must not GAIN any, or the span
  // would drift away from the word it is attached to.
  for (const content of ['plain', 'mid\nnewline', 'a`b']) {
    const rendered = renderedText('x' + afterInline(inlineCode(content)) + 'y')
    assert.match(rendered, /^x\S/, `no space invented before the code span for ${JSON.stringify(content)}`)
    assert.match(rendered, /\Sy$/, `no space invented after the code span for ${JSON.stringify(content)}`)
  }
  ok('inlineCode: whitespace at a code span\'s edges survives inline()\'s line cleanup')

  for (const code of ['code', 'line1\nline2', '```\nembedded fence\n```', '````\ndeeper\n````']) {
    const r = renderedCode(fencedCode(code, 'js'))
    assert.strictEqual(r.count, 1, `fencedCode yields one code block for ${JSON.stringify(code)}`)
    assert.strictEqual(r.text, code, `fencedCode preserves content verbatim for ${JSON.stringify(code)}`)
  }
  ok('fencedCode: one code block, content verbatim, fence outgrows embedded backticks')
}

// --- link classifiers agree (converter emits <-> fidelity checks) ------------
{
  // Normalise both return shapes to the decision that must match: kind + path.
  // (We deliberately do NOT test absolute same-host URLs: the converter's input
  // has every xref already resolved to a relative path by Antora, so it treats
  // all http(s) as external, whereas the fidelity side re-internalises same-host
  // absolutes it finds in RENDERED output. They legitimately differ there.)
  const decide = (r) => ({ kind: r.kind, path: r.path || null })
  const pageUrl = '/cloud/cluster-side-modules'
  const siteHost = 'docs.hazelcast.com'
  const cases = [
    ['#section-id', 'anchor', null],
    ['serverless-cluster', 'internal', '/cloud/serverless-cluster'],
    ['../hazelcast/5.7/sql/sql-statements', 'internal', '/hazelcast/5.7/sql/sql-statements'],
    ['https://example.com/page', 'external', null],
    ['mailto:info@hazelcast.com', 'external', null],
  ]
  for (const [href, kind, path] of cases) {
    const conv = decide(resolveHref(href, pageUrl))
    const fid = decide(classifyHref(href, pageUrl, siteHost))
    assert.deepStrictEqual(conv, fid, `converter vs fidelity agree on ${href}`)
    assert.strictEqual(conv.kind, kind, `${href} classified ${kind}`)
    assert.strictEqual(conv.path, path, `${href} resolves to ${path}`)
  }
  ok('link classifiers: converter (resolveHref) and fidelity (classifyHref) agree on kind + path')

  // A directory page URL resolves a bare relative the same on both sides.
  const conv = resolveHref('install', '/cloud/')
  const fid = classifyHref('install', '/cloud/', 'docs.hazelcast.com')
  assert.strictEqual(conv.path, '/cloud/install', 'converter resolves against a directory URL')
  assert.strictEqual(fid.path, '/cloud/install', 'fidelity resolves against a directory URL identically')
  ok('link classifiers: agree on directory-relative resolution')

  // Whitespace around an href cannot change where the link points -- the browser
  // strips it before parsing (WHATWG URL), so a padded href and its trimmed twin
  // are the SAME destination. Asserted against `new URL` as the oracle rather
  // than against a trim call, so it states the requirement and not the code.
  // `#id ` is the one hz-docs writes (a `<<id , label>>` with a space before the
  // comma): kept verbatim it became `#id%20` in the built page, which is a
  // DIFFERENT and non-existent anchor.
  for (const [padded, bare] of [
    ['#hazelcast.shutdownhook.policy ', '#hazelcast.shutdownhook.policy'],
    [' #section-id', '#section-id'],
    ['serverless-cluster ', 'serverless-cluster'],
    ['https://example.com/page ', 'https://example.com/page'],
  ]) {
    const base = 'https://docs.hazelcast.com' + pageUrl
    assert.strictEqual(new URL(padded, base).href, new URL(bare, base).href,
      `oracle: the browser reads ${JSON.stringify(padded)} as ${JSON.stringify(bare)}`)
    assert.deepStrictEqual(resolveHref(padded, pageUrl), resolveHref(bare, pageUrl),
      `resolveHref points ${JSON.stringify(padded)} at the same place as ${JSON.stringify(bare)}`)
    assert.deepStrictEqual(
      decide(classifyHref(padded, pageUrl, siteHost)), decide(classifyHref(bare, pageUrl, siteHost)),
      `classifyHref agrees for ${JSON.stringify(padded)}`)
  }
  // ...but whitespace INSIDE the fragment is a real character: the browser strips
  // only the ends of the whole string, so this must NOT be normalised away.
  assert.strictEqual(resolveHref('# foo', pageUrl).href, '# foo',
    'a space inside the fragment is preserved')
  ok('link classifiers: whitespace around an href does not move the target')
}

// --- a link label containing square brackets stays ONE parseable link ---------
// Asciidoctor renders an UNRESOLVED internal xref with the id in square brackets
// as its label -- `<<configuring-queue>>` against an anchor that is not on the
// page becomes `<a href="#configuring-queue">[configuring-queue]</a>`. That is
// real: 5.3 data-structures/priority-queue. The brackets must survive as label
// TEXT, and the link must still parse, or the reader sees raw Markdown source.
// Oracle: the same label with the brackets removed, which is unambiguously one
// link -- the bracketed form must differ from it only by those two characters.
{
  const ctx = { pageUrl: '/hazelcast/5.3/data-structures/priority-queue', component: 'hazelcast' }
  const body = (label) => convertBody(`<p>see <a href="#configuring-queue">${label}</a> for more.</p>`, ctx).body
  const bracketed = body('[configuring-queue]')
  const plain = body('configuring-queue')

  // One link, one href -- not source text that failed to parse.
  assert.strictEqual((bracketed.match(/\]\(#configuring-queue\)/g) || []).length, 1,
    'the bracketed label emits exactly one Markdown link')
  assert.strictEqual(bracketed.replace(/\\\[|\\\]/g, ''), plain,
    'and differs from the unbracketed link only by the escaped brackets themselves')
  // The specific failure: escaping a `]` that mdEscape already escaped yields
  // `\\]` -- an escaped BACKSLASH plus a live `]`, which ends the label early.
  assert(!/\\\\\]/.test(bracketed), 'no double-escaped closing bracket')
  ok('link labels: square brackets are escaped once, so the link still parses')
}

// --- internal link with a <Variable> in the label -> raw <a>, site-absolute --
// A marked {attr} in a link label becomes a <Variable/>, which cannot sit inside
// Markdown `[…]`, so the link must emit as a raw <a>. A raw <a> is NOT rewritten
// by Docusaurus's Markdown link resolver, so its href MUST be the site-absolute
// route, not the file-relative `.mdx` the Markdown path uses (that would 404).
// Requirement stated against both branches: same target, two href forms by shape.
{
  // clc's real shape: source and target are flat-slug siblings (/clc/5.5.1/*) but
  // nested at different depths in the file tree, so a file-relative link is `../..`.
  const ctx = {
    pageUrl: '/clc/5.5.1/connect-to-cloud',
    component: 'clc',
    relFile: 'manage/configuration/connect-to-cloud.mdx',
    urlToRelFile: new Map([['/clc/5.5.1/clc-cloud', 'reference/clc-commands/clc-cloud.mdx']]),
  }
  const marked = '<span class="hz-attr-hazelcast-cloud">Cloud</span>'

  // Variable in the label -> raw <a> carrying the SITE-ABSOLUTE, extensionless URL.
  const varLabel = convertBody(`<p>manage <a href="clc-cloud">${marked} clusters</a>.</p>`, ctx).body
  assert(varLabel.includes('<a href="/clc/5.5.1/clc-cloud">'),
    'Variable-labelled internal link emits a raw <a> with the site-absolute route')
  assert(varLabel.includes('<Variable name="hazelcast-cloud"/>'),
    'the marked attr stays a <Variable> in the label (not baked)')
  assert(!/\.mdx/.test(varLabel), 'a raw <a> never carries a .mdx href (Docusaurus would not resolve it)')

  // Contrast: a PLAIN label still takes the Markdown path with a file-relative .mdx
  // link (unchanged behaviour — that form IS resolved by Docusaurus).
  const plainLabel = convertBody('<p>manage <a href="clc-cloud">Cloud clusters</a>.</p>', ctx).body
  assert(plainLabel.includes('[Cloud clusters](../../reference/clc-commands/clc-cloud.mdx)'),
    'a plain-label link keeps the Markdown + file-relative .mdx form')
  ok('link with a <Variable> label: raw <a> + site-absolute href; plain label: markdown + relative .mdx')
}

// --- heal a `link:`-macro doc ref (foo.adoc/.html -> the real page) -----------
// Antora leaves an unresolved `link:clc-script.adoc[…]` as a literal `.adoc`
// href (dead in prod). When the extensionless target is a real page, the
// converter must resolve it to a normal relative .mdx link; when it is NOT a
// real page, it must be left untouched so a genuine dead link still fails L3.
{
  const ctx = {
    pageUrl: '/clc/5.5.1/advanced-scripting',
    component: 'clc',
    relFile: 'guides/advanced-scripting.mdx',
    urlToRelFile: new Map([['/clc/5.5.1/clc-script', 'reference/clc-commands/clc-script.mdx']]),
  }
  // Target exists -> healed to a relative .mdx link, no .adoc.
  const healed = convertBody('<p>See the <a href="clc-script.adoc">script</a> command.</p>', ctx).body
  assert(healed.includes('[script](../reference/clc-commands/clc-script.mdx)'),
    'link:foo.adoc to a real page heals to a relative .mdx link')
  assert(!/\.adoc/.test(healed), 'the .adoc extension is gone once healed')

  // Target does NOT exist -> left as-is (still a dead link, not silently faked).
  const dead = convertBody('<p>See <a href="ghost.adoc">ghost</a>.</p>', ctx).body
  assert(/ghost\.adoc/.test(dead),
    'link:foo.adoc with no matching page is left untouched (stays a real dead link)')
  ok('healDocRef: heals link:*.adoc/.html to a real page, leaves genuine dead links alone')
}

// --- redirect retargeting: a link to a withheld page follows the redirect ----
// SPEC: a page triaged `redirect` is never emitted, so a link to it would resolve
// to a .mdx that does not exist -- and onBrokenLinks is 'warn' during the
// migration, so nothing would stop it shipping. Links to it must be rewritten to
// the redirect's TARGET, leaving the client redirect for the only job it can do:
// old URLs held by bookmarks and by links from outside the site.
{
  const ctx = {
    pageUrl: '/hazelcast/5.5/clients/hazelcast-clients',
    component: 'hazelcast',
    seg: '5.5',
    relFile: 'clients-and-apis/clients/hazelcast-clients.mdx',
    urlToRelFile: new Map([
      // The withheld page still has an entry (it is a page of this version); the
      // point of the retarget is that the link must NOT end up pointing at it.
      ['/hazelcast/5.5/clients/clc', 'clients-and-apis/clients/clc.mdx'],
      ['/hazelcast/5.5/maintain-cluster/rest-api', 'operate-and-manage/maintain-cluster/rest-api.mdx'],
    ]),
    redirectRetargets: new Map([
      ['/hazelcast/5.5/clients/rest', '/hazelcast/5.5/maintain-cluster/rest-api'],
      ['/hazelcast/5.5/clients/clc', '/clc/5.5.1/overview'],
    ]),
  }

  // Same-component target: still a RELATIVE .mdx link, because that is what
  // survives a `docusaurus docs:version` cut.
  const sameComp = convertBody('<p>See the <a href="rest">REST client</a>.</p>', ctx).body
  assert(sameComp.includes('(../../operate-and-manage/maintain-cluster/rest-api.mdx)'),
    'a link to a redirected page resolves to the TARGET, as a relative .mdx link')
  assert(!/clients\/rest/.test(sameComp), 'and no longer mentions the withheld page')

  // Cross-component target: no relative form exists (a file link cannot cross a
  // plugin instance), so the absolute route is emitted -- and emitted VERBATIM,
  // never floated to /clc/latest/, which is not a route this site serves.
  const crossComp = convertBody('<p>Use the <a href="clc">CLC</a>.</p>', ctx).body
  assert(crossComp.includes('(/clc/5.5.1/overview)'),
    'a cross-component redirect target is emitted as its absolute pinned route')
  assert(!/clc\/latest/.test(crossComp), 'a pinned cross-component target is never floated to /latest/')
  assert(!/clients-and-apis\/clients\/clc\.mdx/.test(crossComp),
    'and never points at the withheld page\'s own file, which is not written')

  // The fragment is the referrer's content, not the retarget's business.
  const withHash = convertBody('<p>See <a href="rest#enabling">enabling it</a>.</p>', ctx).body
  assert(withHash.includes('rest-api.mdx#enabling'), 'a #fragment rides along untouched')

  // A page with no redirect decision is completely unaffected.
  const untouched = convertBody('<p>The <a href="../maintain-cluster/rest-api">API</a>.</p>', ctx).body
  assert(untouched.includes('(../../operate-and-manage/maintain-cluster/rest-api.mdx)'),
    'a link to a normal page is resolved the ordinary way')
  ok('retargetRedirect: links to withheld pages follow the redirect, same- and cross-component')
}

// --- partials: id parsing, slug + component naming ---------------------------
{
  assert.deepStrictEqual(parseId('cloud:ROOT:partial$create-api-key.adoc'),
    { component: 'cloud', module: 'ROOT', family: 'partial', relative: 'create-api-key.adoc' }, 'parses a ROOT id')
  assert.deepStrictEqual(parseId('operator:mymod:page$dir/sub.adoc'),
    { component: 'operator', module: 'mymod', family: 'page', relative: 'dir/sub.adoc' }, 'parses a module + nested id')
  ok('parseId: splits component:module:family$relative')

  // Correctness properties (these MUST hold, whatever the scheme):
  //  - two partials with the same relative path in DIFFERENT modules must not
  //    collide, so the module has to survive into the slug;
  //  - the name is emitted as a JSX component + import binding, so it must be a
  //    valid capitalised JS identifier (JSX treats lowercase as an HTML tag).
  assert.notStrictEqual(slugFor('c:modA:partial$note.adoc'), slugFor('c:modB:partial$note.adoc'),
    'same-named partials in different modules get different slugs (no collision)')
  for (const slug of ['create-api-key', 'mymod-deep-path-note', 'a1-b2'])
    assert(/^[A-Z][A-Za-z0-9]*$/.test(componentNameFor(slug)), `componentNameFor(${slug}) is a valid JSX identifier`)
  ok('slugFor / componentNameFor: module-safe slug + valid JSX component identifier')

  // Tripwire (no external spec for the exact scheme): pins today's output so an
  // unintended change is noticed. NOT a correctness check.
  assert.strictEqual(slugFor('cloud:ROOT:partial$create-api-key.adoc'), 'create-api-key', 'current slug scheme')
  assert.strictEqual(componentNameFor('create-api-key'), 'PartialCreateApiKey', 'current naming scheme')
  ok('slugFor / componentNameFor: current output pinned (change-detector)')
}

// --- partials: occurrence collection -----------------------------------------
{
  const block = collectOccurrences(
    '<div><!--hz-partial:start cloud:ROOT:partial$x.adoc--><p>body</p><!--hz-partial:end cloud:ROOT:partial$x.adoc--></div>')
  assert.deepStrictEqual(block, [{ id: 'cloud:ROOT:partial$x.adoc', inner: '<p>body</p>', blockLevel: true }],
    'block-level region: id, inner HTML, blockLevel true')

  const inline = collectOccurrences(
    '<p>text <!--hz-partial:start cloud:ROOT:partial$y.adoc--><span>z</span><!--hz-partial:end cloud:ROOT:partial$y.adoc--></p>')
  assert.strictEqual(inline[0].blockLevel, false, 'region inside a <p> is not block-level')
  ok('collectOccurrences: pairs sentinels, captures inner HTML, flags inline parents')
}

// --- partials: the factoring decision ----------------------------------------
{
  const occ = (id, inner, blockLevel = true) => ({ id, inner, blockLevel })
  const shared = decide([
    { url: '/a', occ: [occ('c:ROOT:partial$p.adoc', '<p>same</p>')] },
    { url: '/b', occ: [occ('c:ROOT:partial$p.adoc', '<p>same</p>')] },
  ], 'c')
  assert(shared.decisions.has('c:ROOT:partial$p.adoc'), 'identical block-level occurrences on 2 pages -> factored')
  assert.strictEqual(shared.decisions.get('c:ROOT:partial$p.adoc').importStmt,
    "import PartialP from '@site/c/_partials/p.mdx';", 'factored id imports from the current version base')

  const varies = decide([
    { url: '/a', occ: [occ('c:ROOT:partial$p.adoc', '<p>one</p>')] },
    { url: '/b', occ: [occ('c:ROOT:partial$p.adoc', '<p>two</p>')] },
  ], 'c')
  assert(!varies.decisions.has('c:ROOT:partial$p.adoc'), 'differing inner HTML -> declined')
  assert.strictEqual(varies.report[0].reason, 'content-varies', 'decline reason recorded')

  const notBlock = decide([{ url: '/a', occ: [occ('c:ROOT:partial$p.adoc', '<span>x</span>', false)] }], 'c')
  assert.strictEqual(notBlock.report[0].reason, 'non-block-level', 'non-block occurrence -> declined')

  // Two distinct ids that slugify identically (a-b.adoc and a/b.adoc): first wins.
  const collide = decide([
    { url: '/a', occ: [occ('c:ROOT:partial$a-b.adoc', '<p>x</p>')] },
    { url: '/b', occ: [occ('c:ROOT:partial$a/b.adoc', '<p>y</p>')] },
  ], 'c')
  assert(collide.decisions.has('c:ROOT:partial$a-b.adoc'), 'first id claims the slug')
  const collided = collide.report.find((r) => r.id === 'c:ROOT:partial$a/b.adoc')
  assert.strictEqual(collided.reason, 'slug-collision', 'second id with the same slug is declined')
  ok('decide: factors identical block-level partials, declines varies/non-block/slug-collision')

  // A versioned copy's partials import from ITS OWN tree, not current's -- the
  // regression guard for the version-bleed that clc 5.5.0 exposed (a factored
  // partial whose text changed in 5.5.1 must not leak back into 5.5.0).
  const versioned = decide([
    { url: '/clc/5.5.0/x', occ: [occ('clc:ROOT:partial$global-parameters.adoc', '<p>same</p>')] },
    { url: '/clc/5.5.0/y', occ: [occ('clc:ROOT:partial$global-parameters.adoc', '<p>same</p>')] },
  ], 'clc_versioned_docs/version-5.5.0')
  assert.strictEqual(versioned.decisions.get('clc:ROOT:partial$global-parameters.adoc').importStmt,
    "import PartialGlobalParameters from '@site/clc_versioned_docs/version-5.5.0/_partials/global-parameters.mdx';",
    'a release imports its partial from its own versioned_docs tree, not @site/<component>')
  ok('decide: version-scoped import base (no cross-version partial bleed)')
}

// --- nav: target parsing + folder name ---------------------------------------
// SPEC: a nav target's KEY must identify the page, and a multi-module component
// has same-named pages in different modules (management-center has 13, across 5
// name groups), so the key has to carry the module. It is Antora's own coordinate
// so an injected nav line can be written with it verbatim. The bare `stem` remains
// the page's NAME, for folders and humanised labels.
{
  assert.deepStrictEqual(parseTarget('install.adoc'), { key: 'install', stem: 'install' },
    'plain (ROOT-module) target: key is the bare stem')
  assert.deepStrictEqual(parseTarget('mymod:page.adoc#frag'), { key: 'mymod:page', stem: 'page' },
    'module coordinate is kept in the key; the fragment is dropped')
  assert.deepStrictEqual(parseTarget('ROOT:page.adoc'), { key: 'page', stem: 'page' },
    'an explicit ROOT coordinate keys the same as writing no coordinate at all')
  assert.deepStrictEqual(parseTarget('mymod:dir/page.adoc'), { key: 'mymod:dir/page', stem: 'page' },
    'a page in a module subdir keeps its path in the key, but not in the stem')
  assert.deepStrictEqual(parseTarget('5.7@comp:mymod:page.adoc'),
    { key: 'mymod:page', stem: 'page' }, 'version@ and component coordinates are stripped; the module is the last one')
  // The two same-stem pages that used to collide must now be distinct keys.
  assert.notStrictEqual(parseTarget('clusters:dashboard.adoc').key, parseTarget('cp-subsystem:dashboard.adoc').key,
    'same stem in two modules -> two different keys')
  // pageKey is the page-side derivation; it must agree with the nav side exactly,
  // or a page silently misses the nav entry that names it.
  assert.strictEqual(pageKey('clusters', 'dashboard'), parseTarget('clusters:dashboard.adoc').key,
    'pageKey (manifest side) and parseTarget (nav side) agree')
  assert.strictEqual(pageKey('ROOT', 'ask-ai'), parseTarget('ask-ai.adoc').key,
    'pageKey leaves ROOT implicit, as the nav does')
  assert.strictEqual(folderName('Data Structures & Maps'), 'data-structures-maps', 'label -> kebab folder name')
  ok('parseTarget / pageKey / folderName: nav target and label normalisation')
}

// --- nav: parse the nav.adoc grammar -----------------------------------------
{
  const roots = parseNav('.Get Started\n* xref:install.adoc[Install]\n* xref:configure.adoc[Configure]\n** xref:advanced.adoc[Advanced]')
  assert.strictEqual(roots.length, 1, 'one top-level category')
  assert.strictEqual(roots[0].type, 'category', 'a .Title line is a category')
  const [install, configure] = roots[0].children
  assert(install.type === 'page' && install.stem === 'install' && install.label === 'Install', 'depth-1 page item')
  assert(configure.children[0].stem === 'advanced', 'depth-2 item nests under the preceding depth-1')
  ok('parseNav: categories, page items, and depth nesting')

  const grouped = parseNav('.Reference\n* Data\n** xref:maps.adoc[Maps]')
  const data = grouped[0].children[0]
  assert(data.type === 'category' && data.label === 'Data', 'a bullet with no xref is a grouping (sub-category)')
  assert(data.children[0].stem === 'maps', 'grouping nests its page children')
  ok('parseNav: a bullet item without an xref becomes a grouping category')
}

// --- nav: build the emission plan --------------------------------------------
{
  const path = require('node:path')

  // Correctness property: a plan entry supplies the file a page is WRITTEN to, so
  // two distinct pages sharing one relFile means the second write destroys the
  // first and one of the two URLs then serves the other's content. Whatever the
  // folder layout, the map from key to relFile must stay injective.
  // (The slug — the actual URL preserver — is deliberately NOT the plan's business;
  // convert.js derives it from the page's real URL. See buildPlan's header.)
  const plan = buildPlan(parseNav([
    '.Guide',
    '* xref:intro.adoc[Intro]',
    '* xref:section.adoc[Section]', // parent page -> Overview
    '** xref:child.adoc[Child]',
  ].join('\n')))
  const files = [...plan.pages.values()].map((p) => p.relFile)
  assert.strictEqual(new Set(files).size, files.length, 'no two planned pages share an output file')
  assert.ok([...plan.pages.values()].every((p) => !('slug' in p)),
    'the plan carries no slug: guessing a URL from the nav is what drops module segments')
  ok('buildPlan: distinct pages never share an output file')

  // --- SPEC: same-stem pages in different modules -----------------------------
  // The multi-module case (management-center). Requirement stated independently of
  // the walk: three pages named `dashboard` in three modules are three pages, so
  // the plan must hold three entries, write three files, and report no duplicate.
  {
    const multi = buildPlan(parseNav([
      '.Monitor',
      '* xref:clusters:dashboard.adoc[Cluster]',
      '* xref:cp-subsystem:dashboard.adoc[CP Subsystem]',
      '* xref:monitor-streaming:dashboard.adoc[Streaming]',
    ].join('\n')))
    assert.strictEqual(multi.pages.size, 3, 'three same-named pages in three modules -> three plan entries')
    assert.deepStrictEqual(multi.duplicates, [],
      'they are NOT duplicates: a duplicate means one page listed twice, not two pages named alike')
    const multiFiles = [...multi.pages.values()].map((p) => p.relFile)
    assert.strictEqual(new Set(multiFiles).size, 3, 'each gets its own output file')
    // Placed in ONE nav folder, the bare filenames collide; the module coordinate
    // is what disambiguates, rather than the filesystem silently picking a winner.
    assert.ok(multiFiles.some((f) => /dashboard-(clusters|cp-subsystem|monitor-streaming)\.mdx$/.test(f)),
      'a filename collision within one folder is resolved by qualifying with the module')
    ok('buildPlan: same-stem pages in different modules stay distinct pages')
  }

  // --- SPEC: migration-injected nav entries ----------------------------------
  // A page missing from nav.adoc gets no plan entry, so it would be emitted at
  // the component root as `unlisted`. Injecting the entry must make it
  // indistinguishable from a page that was in the nav all along: same folder,
  // same depth, a sidebar_position in the right order, and the URL untouched.
  // Oracle = an equivalent nav that CONTAINS the entry, so the test states the
  // required equivalence rather than mirroring the insertion code.
  {
    const source = ['.Reference', '* xref:commands.adoc[Command Reference]',
      '** xref:cfg.adoc[]', '** xref:demo.adoc[]'].join('\n')
    const asIfPresent = ['.Reference', '* xref:commands.adoc[Command Reference]',
      '** xref:cfg.adoc[]', '** xref:cpmap.adoc[]', '** xref:demo.adoc[]'].join('\n')

    const injected = buildPlan(parseNav(injectNavEntries(source, [{ key: 'cpmap', after: 'cfg' }])))
    const expected = buildPlan(parseNav(asIfPresent))

    assert.deepStrictEqual(injected.pages.get('cpmap'), expected.pages.get('cpmap'),
      'an injected page is planned exactly as if nav.adoc had listed it')
    // Placement: it lands between its anchor and the next sibling, and pushes
    // that sibling down — i.e. it is really IN the order, not appended.
    const pos = (p, s) => p.pages.get(s).sidebarPosition
    assert(pos(injected, 'cfg') < pos(injected, 'cpmap') && pos(injected, 'cpmap') < pos(injected, 'demo'),
      'injected entry sits between its anchor and the following sibling')
    assert.strictEqual(pos(injected, 'demo'), pos(expected, 'demo'),
      'the displaced sibling gets the same position it would have had')
    // Injection is by ANCHOR, not by line number: same anchor, different nav shape.
    const deeper = injectNavEntries('.R\n* xref:top.adoc[T]\n** xref:cfg.adoc[]', [{ key: 'cpmap', after: 'cfg' }])
    assert(/^\*\* xref:cpmap\.adoc\[\]$/m.test(deeper), 'injected entry copies its anchor\'s depth')
    // A module-qualified key must inject a MODULE-QUALIFIED xref: a bare stem would
    // resolve against ROOT and the nav entry would point at nothing.
    const inMod = injectNavEntries('.R\n* xref:mymod:cfg.adoc[]', [{ key: 'mymod:cpmap', after: 'mymod:cfg' }])
    assert(/^\* xref:mymod:cpmap\.adoc\[\]$/m.test(inMod), 'injected entry names its module as an xref coordinate')
    assert(buildPlan(parseNav(inMod)).pages.has('mymod:cpmap'),
      'and the injected line round-trips back to the key it came from')
    // A missing anchor must be loud: silently skipping would leave the page an
    // orphan at the component root, the exact state injection exists to fix.
    assert.throws(() => injectNavEntries(source, [{ key: 'cpmap', after: 'nope' }]), /anchor/i,
      'a missing anchor throws rather than silently doing nothing')
    assert.strictEqual(injectNavEntries(source, []), source, 'no injections leaves the nav byte-identical')
    ok('injectNavEntries: injected page is planned as if the nav had listed it')

    // A disposition covers a page across EVERY branch, but a page is only an
    // orphan in the branches whose nav omits it. Where this version's nav already
    // lists the page, the injection has nothing to do -- and must not duplicate the
    // entry, nor throw because the anchor it would have used is itself a page that
    // version predates. Oracle = the untouched nav, which is what "nothing to do"
    // means. This is hazelcast:maintain-cluster/rest-api at 5.4 and 5.3 exactly.
    const already = ['.Reference', '* xref:commands.adoc[Command Reference]',
      '** xref:cfg.adoc[]', '** xref:cpmap.adoc[]'].join('\n')
    assert.strictEqual(injectNavEntries(already, [{ key: 'cpmap', after: 'cfg' }]), already,
      'a page its nav already lists is left alone, not injected twice')
    assert.strictEqual(injectNavEntries(already, [{ key: 'cpmap', after: 'no-such-anchor' }]), already,
      'and needs no anchor, because there is nothing to place')
    // The presence check must be by KEY, not by stem: a same-named page in another
    // module is a different page and must not suppress the injection.
    const otherMod = '.R\n* xref:mymod:cfg.adoc[]\n* xref:othermod:cpmap.adoc[]'
    assert(/^\* xref:mymod:cpmap\.adoc\[\]$/m.test(injectNavEntries(otherMod, [{ key: 'mymod:cpmap', after: 'mymod:cfg' }])),
      'a same-stem page in a different module does not count as already listed')
    ok('injectNavEntries: an injection whose page is already in nav is a no-op')
  }

  // Correctness: nav includes are resolved SPLICED IN PLACE, because an included
  // partial's own bullet depths are interpreted where the include sat -- position
  // is what places the whole subtree. Oracle = the equivalent flat nav with the
  // partial's text written out inline, so the test states the equivalence Antora
  // guarantees rather than mirroring the splice.
  {
    const partials = {
      'computing:nav.adoc': '* Java Executor Service\n** xref:computing:executor-service.adoc[]\n',
      'ROOT:extra.adoc': '** xref:extra.adoc[Extra]',
    }
    const read = (module, relPath) => partials[`${module || 'ROOT'}:${relPath}`]

    const withInclude = ['.Develop', '* xref:computing:distributed-computing.adoc[]',
      '** Executor Services', 'include::computing:partial$nav.adoc[]',
      '* xref:last.adoc[Last]'].join('\n')
    const flat = ['.Develop', '* xref:computing:distributed-computing.adoc[]',
      '** Executor Services', '* Java Executor Service',
      '** xref:computing:executor-service.adoc[]', '* xref:last.adoc[Last]'].join('\n')

    assert.deepStrictEqual(buildPlan(parseNav(resolveNavIncludes(withInclude, read))), buildPlan(parseNav(flat)),
      'an included partial plans exactly as if its text were written inline at the include')
    // Position matters: the partial's depths are read where the include sat, so
    // the entries after it keep their own place rather than being appended past.
    const plan = buildPlan(parseNav(resolveNavIncludes(withInclude, read)))
    assert(plan.pages.get('computing:executor-service').sidebarPosition < plan.pages.get('last').sidebarPosition,
      'entries following the include stay after the text it pulled in')
    // A partial with no module coordinate belongs to the nav's own module.
    assert(buildPlan(parseNav(resolveNavIncludes('.R\n* xref:top.adoc[T]\ninclude::partial$extra.adoc[]', read))).pages.has('extra'),
      'a module-less partial coordinate resolves against the nav\'s own module')
    // A flat nav has no include lines: unchanged, byte for byte. This is what
    // makes the change a no-op on 5.5-and-newer Platform and on every other
    // component.
    assert.strictEqual(resolveNavIncludes(flat, read), flat, 'a nav with no includes is returned unchanged')
    // A COMMENTED include is not a directive -- management-center's navs disable
    // every module partial that way, and must keep parsing as flat files.
    const commented = '.R\n* xref:top.adoc[T]\n// include::computing:partial$nav.adoc[]'
    assert.strictEqual(resolveNavIncludes(commented, read), commented, 'a commented-out include is left alone')
    // Fails closed both ways: a nav include that silently resolved to nothing
    // would cost a whole subtree its placement while the build stayed green.
    assert.throws(() => resolveNavIncludes('include::nope:partial$nav.adoc[]', read), /could not be resolved/i,
      'an unresolvable partial throws rather than vanishing')
    assert.throws(() => resolveNavIncludes('include::some:example$thing.adoc[]', read), /unsupported include/i,
      'an include form this does not understand throws rather than being dropped')
    // A partial that includes itself must give a legible error, not a stack blowup.
    const cyclic = (module, relPath) => (relPath === 'loop.adoc' ? 'include::partial$loop.adoc[]' : undefined)
    assert.throws(() => resolveNavIncludes('include::partial$loop.adoc[]', cyclic), /cycle|nested more than/i,
      'a self-referential nav partial is reported, not recursed forever')
    ok('resolveNavIncludes: a partial plans as if spliced inline, and failures are loud')
  }

  // Correctness: a nav label equal to the doctitle is redundant -> no sidebar_label;
  // a distinct nav label is kept.
  const withTitle = buildPlan(parseNav('.Guide\n* xref:install.adoc[Install]'), new Map([['install', 'Install']]))
  assert.strictEqual(withTitle.pages.get('install').sidebarLabel, null, 'redundant sidebar_label dropped')
  const noTitle = buildPlan(parseNav('.Guide\n* xref:install.adoc[Install]'))
  assert.strictEqual(noTitle.pages.get('install').sidebarLabel, 'Install', 'a distinct nav label is kept')
  ok('buildPlan: sidebar_label kept only when it differs from the title')

  // Correctness: two pages with the same stem would fight for one URL -> reported.
  assert.deepStrictEqual(buildPlan(parseNav('.Guide\n* xref:x.adoc[X]\n* xref:x.adoc[Y]')).duplicates, ['x'],
    'a stem appearing twice is reported as a duplicate (URL conflict)')
  ok('buildPlan: reports duplicate stems')

  // Tripwire (internal design, no external spec): folder layout, the Overview
  // split, and the non-clickable category file. Pins current output; not a
  // correctness check.
  assert.strictEqual(noTitle.pages.get('install').relFile, path.join('guide', 'install.mdx'), 'leaf file layout')
  assert.strictEqual(plan.pages.get('section').relFile, path.join('guide', 'section', 'overview.mdx'),
    'parent-page content lands in overview.mdx under its own folder')
  assert.deepStrictEqual(noTitle.categories[0].content, { label: 'Guide', position: 1, link: null },
    'category is a non-clickable grouping (link:null)')
  ok('buildPlan: file layout / Overview split / category files pinned (change-detector)')

  // Correctness: a page listed in a SECOND nav location (here a dedicated
  // `.Release Notes` section repeating a page already placed under `.Guide`)
  // must not spawn an empty category. The requirement, stated independently of
  // the walk: the page keeps its FIRST location, the duplicate is reported, and
  // NO _category_.json is emitted for a folder that would hold nothing. Mirrors
  // the versioned operator navs (release-notes.adoc under Get started + a
  // Release Notes section).
  const dupSection = buildPlan(parseNav([
    '.Guide',
    '* xref:release-notes.adoc[]',
    '.Release Notes',
    '* xref:release-notes.adoc[5.18.0]',
  ].join('\n')))
  assert.strictEqual(dupSection.pages.get('release-notes').relFile, path.join('guide', 'release-notes.mdx'),
    'the page stays at its first nav location')
  assert.deepStrictEqual(dupSection.duplicates, ['release-notes'], 'the second occurrence is reported as a duplicate')
  assert.ok(!dupSection.categories.some((c) => c.relFile.split(path.sep).includes('release-notes')),
    'no empty _category_.json is emitted for the collapsed Release Notes section')
  assert.ok(dupSection.categories.some((c) => c.content.label === 'Guide'),
    'a section that DID place a page still emits its category')
  ok('buildPlan: a page repeated in a second nav section drops that empty category')
}

// --- SPEC: a column's alignment survives as a GFM delimiter ------------------
// `[cols="<30%,^15%,^15%,<40%"]` reaches the golden as halign-left/center on the
// cells; GFM says the same thing in the delimiter row, so it must round-trip.
// management-center's feature matrix centres its two ✓/✗ columns deliberately,
// and NOTHING catches the loss -- Layer 1 compares text, Layer 2 counts elements.
// The oracle is a real CommonMark+GFM render: assert the built cells carry the
// alignment, rather than asserting the delimiter string the converter chose.
{
  const cell = (tag, align, text) => `<${tag} class="tableblock halign-${align} valign-top"><p class="tableblock">${text}</p></${tag}>`
  const table = (aligns) =>
    '<table class="tableblock frame-all grid-all stretch"><thead><tr>' +
    aligns.map((a, i) => cell('th', a, `H${i}`)).join('') +
    '</tr></thead><tbody><tr>' +
    aligns.map((a, i) => cell('td', a, `v${i}`)).join('') +
    '</tr></tbody></table>'

  const { body } = convertBody(table(['left', 'center', 'right']), { pageUrl: '/x' })
  const $ = cheerio.load(micromark(body, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }))
  const styles = $('tbody td').toArray().map((td) => ($(td).attr('align') || $(td).attr('style') || '').replace(/text-align:\s*/, '').replace(/;$/, ''))
  assert.strictEqual(styles[1], 'center', 'a ^ (centre) column renders centred')
  assert.strictEqual(styles[2], 'right', 'a > (right) column renders right-aligned')
  assert.ok(!styles[0], 'a left column emits no alignment (left is the GFM default, so the render is identical)')

  // A table with no alignment at all is byte-unchanged -- this is what keeps the
  // change from rewriting every already-converted table.
  const plain = convertBody(
    '<table class="tableblock"><thead><tr><th class="tableblock"><p class="tableblock">H</p></th></tr></thead>' +
    '<tbody><tr><td class="tableblock"><p class="tableblock">v</p></td></tr></tbody></table>', { pageUrl: '/x' }).body
  assert.strictEqual(plain, '| H |\n| --- |\n| v |', 'an unaligned table keeps the bare --- delimiter')
  ok('table alignment: ^ and > columns round-trip as GFM delimiters (GFM oracle)')
}

// --- SPEC: an icon that is CONTENT survives; a decorative one is dropped -----
// Asciidoctor emits <i class="fa …"> for BOTH the admonition/checklist glyphs
// (chrome — Docusaurus draws its own) and for `icon:x[role=y]` used as data. The
// discriminator is the `span.icon <role>` wrapper, which only the latter carries.
// management-center's feature matrix is the real case: 36 ticks and crosses per
// version that were being dropped, leaving "feature | | | description" rows.
{
  const iconCell = (role, glyph) =>
    `<div class="paragraph"><p><span class="icon ${role}"><i class="fa fa-${glyph} fa-lg"></i></span></p></div>`

  const { body: yes } = convertBody(iconCell('success', 'check-circle'), { pageUrl: '/x' })
  assert.strictEqual(yes, '<Icon role="success"/>', 'icon:check-circle[role=success] -> <Icon role="success"/>')
  const { body: no } = convertBody(iconCell('error', 'times'), { pageUrl: '/x' })
  assert.strictEqual(no, '<Icon role="error"/>', 'icon:times[role=error] -> <Icon role="error"/>')

  // No TEXT is emitted, which is the fidelity requirement: the golden's <i> holds
  // none, so a ✓/✗ character here would add content the source never rendered.
  assert.strictEqual(renderedText(yes.replace(/<[^>]+>/g, '')), '', 'a content icon contributes no text')

  // Decoration still goes: an admonition glyph and a bare <i> with no span.icon
  // wrapper must vanish rather than become an empty `*`/`**`.
  const { body: chrome } = convertBody(
    '<div class="paragraph"><p><i class="fa icon-note"></i>Body text</p></div>', { pageUrl: '/x' })
  assert.strictEqual(chrome, 'Body text', 'a decorative glyph is dropped, leaving no empty emphasis')

  // An UNKNOWN role has no glyph in the front-end registry, so it must NOT become
  // an <Icon> that renders nothing — it keeps the old dropped behaviour until the
  // registry gains an entry.
  const { body: unknown } = convertBody(iconCell('warning', 'exclamation'), { pageUrl: '/x' })
  assert.strictEqual(unknown, '', 'an unregistered role is not emitted as <Icon>')
  ok('content icons: span.icon <role> becomes <Icon>, decoration is still dropped')
}

// --- SPEC: a checklist keeps its checkbox (GFM task list) --------------------
// `- [ ]` / `- [*]` render as <ul class="checklist"> with a checkbox glyph. The
// box is the item's STATE, not decoration, and GFM expresses it natively — so the
// marker round-trips as itself. cloud's migrate-to-cloud is the real case (its
// own prose says "see the following checklist"), where it had become a plain
// bullet list. Nothing else catches this: the glyph carries no text for Layer 1
// and Layer 2 counts no icons.
{
  const item = (glyph, text) =>
    `<li><p><i class="fa fa-${glyph}"></i> ${text}</p></li>`
  const list = (...items) => `<div class="ulist checklist"><ul class="checklist">${items.join('')}</ul></div>`

  const { body } = convertBody(list(item('square-o', 'Todo'), item('check-square-o', 'Done')), { pageUrl: '/x' })
  assert.strictEqual(body, '- [ ] Todo\n- [x] Done',
    'unchecked -> `- [ ]`, checked -> `- [x]`; the state is preserved, not flattened')

  // A plain (non-checklist) ulist is untouched — no stray checkboxes.
  const { body: plain } = convertBody(
    '<div class="ulist"><ul><li><p>Just a bullet</p></li></ul></div>', { pageUrl: '/x' })
  assert.strictEqual(plain, '- Just a bullet', 'an ordinary bullet list gains no checkbox')
  ok('checklists: the checkbox state round-trips as a GFM task list')
}

// --- fixSwallowedBlockTitles: recover a mis-rendered block title ------------
// The requirement: when a spurious `+` swallows a following `.Block Title` and
// Asciidoctor bakes both into one literal paragraph (`<p>+\n.Title</p>`) ahead
// of an untitled code block, the converter must restore the title onto that
// block and drop the stray paragraph -- and must NOT touch anything that is not
// exactly that shape. Oracle is the spec stated three ways, not the code.
{
  const { convertBody } = require('./lib/html-to-mdx')
  const listing = (title, code) =>
    '<div class="listingblock">' +
    (title ? `<div class="title">${title}</div>` : '') +
    `<div class="content"><pre class="highlight"><code class="language-shell" data-lang="shell">${code}</code></pre></div>` +
    '</div>'
  const para = (t) => `<div class="paragraph"><p>${t}</p></div>`

  // The real shape from operator scale.adoc: a correctly titled block, then the
  // swallowed-title paragraph, then the untitled block that lost its title.
  const buggy = listing('For Kubernetes', 'kubectl apply -f x.yaml') +
    para('+\n.For Openshift') +
    listing(null, 'oc apply -f x.yaml')
  const { body } = convertBody(buggy, {})
  assert.ok(/title="For Openshift"/.test(body), 'swallowed title is re-attached to the code block')
  assert.ok(!/\+\s*\.?For Openshift/.test(body) && !/^\s*\\?\+/m.test(body), 'the stray `+ .Title` paragraph is gone')
  assert.ok(/oc apply -f x\.yaml/.test(body), 'the code that lost its title is preserved')
  assert.ok(/title="For Kubernetes"/.test(body), 'an already-correct title is left intact')
  ok('fixSwallowedBlockTitles: recovers `+ .Title` before an untitled code block')

  // Negatives: the repair is keyed to the precise signature, so none of these
  // move. (a) title-line present but next block already titled; (b) `+ .Title`
  // not followed by a listing block; (c) an ordinary paragraph starting with a
  // literal `+`.
  const alreadyTitled = para('+\n.For Openshift') + listing('Real Title', 'oc apply')
  assert.ok(/title="Real Title"/.test(convertBody(alreadyTitled, {}).body) &&
    !/title="For Openshift"/.test(convertBody(alreadyTitled, {}).body),
    'a block that already has a title is never overwritten')
  const noBlock = para('+\n.For Openshift') + para('just prose')
  assert.ok(!/title="For Openshift"/.test(convertBody(noBlock, {}).body),
    'no title is invented when no code block follows')
  const plainPlus = para('1 + 1 = 2') + listing(null, 'code')
  assert.ok(!/title=/.test(convertBody(plainPlus, {}).body),
    'an ordinary paragraph is not consumed as a swallowed title')
  ok('fixSwallowedBlockTitles: leaves non-matching shapes untouched')
}

// --- a block title on a PARAGRAPH survives -----------------------------------
// Asciidoctor puts a paragraph's `.Title` in a <div class="title"> BESIDE the <p>,
// so a handler that reads only the <p> drops it. The spec: the title's text
// reaches the output as its own block, ABOVE the paragraph's content, with its
// inline markup converted -- and an untitled paragraph is byte-for-byte unchanged.
// Oracle is the golden shape from management-center tools/sql-browser (a title
// above an inline image), not the implementation.
{
  const { convertBody } = require('./lib/html-to-mdx')
  const titled = '<div class="paragraph"><div class="title">Example query results</div>' +
    '<p><span class="image"><img src="_images/SQLBrowserQueryResultTab.png" alt="A list of query results"></span></p></div>'
  const { body } = convertBody(titled, {})
  assert.ok(body.includes('Example query results'), 'the title text is not dropped')
  assert.ok(body.indexOf('Example query results') < body.indexOf('!['),
    'it comes ABOVE the block it titles')
  assert.match(body, /Example query results\n\s*\n/, 'and is its own block, not glued to the content')
  assert.ok(body.includes('![A list of query results]'), 'the paragraph content still converts')

  // Inline markup in a title is converted, not flattened to text.
  const marked = '<div class="paragraph"><div class="title">The <code>foo</code> result</div><p>body</p></div>'
  assert.ok(convertBody(marked, {}).body.includes('`foo`'), 'inline markup inside a title is converted')

  // An untitled paragraph is untouched -- the change must not perturb the 99%.
  const plain = '<div class="paragraph"><p>Just prose.</p></div>'
  assert.strictEqual(convertBody(plain, {}).body.trim(), 'Just prose.',
    'an untitled paragraph is unchanged')

  // No <p> at all (Asciidoctor emits bare cell text this way): the title must
  // still appear exactly once, never doubled by the fallback path.
  const noP = '<div class="paragraph"><div class="title">Caption</div>bare text</div>'
  const nb = convertBody(noP, {}).body
  assert.strictEqual((nb.match(/Caption/g) || []).length, 1, 'the title is emitted exactly once')
  ok('paragraph block title: kept as its own block, above the content, once')
}

// --- URLs in prose: no invented links, placeholders as code ------------------
// Two rules, both about a URL the golden does NOT present as a link.
// (a) Markdown autolinks a bare URL where Asciidoctor did not, ADDING a link.
// (b) An address the reader types (loopback / .local / example.*) is not a
//     destination, so it reads as code -- normalising the five ways the corpus
//     authors it. (b) diverges from the golden ON PURPOSE and is accept-listed.
// Oracle: the real golden shapes from management-center, plus the controls that
// must NOT move.
{
  const { convertBody } = require('./lib/html-to-mdx')
  const para = (inner) => `<div class="paragraph"><p>${inner}</p></div>`
  const body = (html) => convertBody(html, {}).body.trim()
  const bare = (u) => `<a href="${u}" class="bare">${u}</a>`

  // (a) a bare URL in prose that the golden did NOT link. This used to be the
  // Swagger pages -- an unregistered macro's text carrying a bare URL -- and
  // since those convert to <ApiReference> the corpus has no live occurrence
  // left: every remaining bare URL in the golden is a placeholder, handled by
  // (b) below. The rule stays as a SAFETY NET (a new one must not silently gain
  // a link), so it is stated here on a synthetic input instead.
  const unlinked = body(para('Fetch it from https://github.com/hazelcast/x.yaml first.'))
  assert.ok(!/\[https|\]\(/.test(unlinked), 'no Markdown link is invented')
  assert.ok(unlinked.includes('https:{/**/}//github.com/hazelcast/x.yaml'),
    'the text run is split just after the scheme so GFM cannot autolink it')
  assert.ok(!unlinked.includes('https://github'), 'the contiguous URL is gone from the source text')

  // (b) placeholder URLs, in all three shapes the corpus uses.
  assert.strictEqual(body(para('at https://localhost:443.')), 'at `https://localhost:443`.',
    'a placeholder left as text becomes code, and the full stop stays outside it')
  assert.strictEqual(body(para('enter \u201chttp://127.0.0.1:8080/oidc/auth\u201d.')),
    'enter "`http://127.0.0.1:8080/oidc/auth`".',
    'the closing typographic quote is not swallowed into the code span')
  assert.strictEqual(body(para(`a site (${bare('https://example.com')})`)), 'a site (`https://example.com`)',
    "a golden AUTOLINK of a placeholder loses the link and keeps the text as code")
  assert.strictEqual(body(para(`at <code>${bare('http://localhost:2222/metrics')}</code>.`)),
    'at `http://localhost:2222/metrics`.',
    'a placeholder autolinked INSIDE a code span keeps the code, drops the link')

  // Controls: real links must not move.
  assert.strictEqual(body(para(`see ${bare('https://hazelcast.com/pricing/')}.`)),
    'see [https://hazelcast.com/pricing/](https://hazelcast.com/pricing/).',
    'a real external link survives, and its URL LABEL is not autolink-broken')
  assert.strictEqual(body(para('see <a href="https://x.com/a">the docs</a>.')), 'see [the docs](https://x.com/a).',
    'a labelled external link is untouched')
  assert.strictEqual(body(para('see <a href="http://localhost:8080">the console</a>.')),
    'see [the console](http://localhost:8080).',
    'a placeholder URL with a REAL label keeps its link -- code would lose the label')
  assert.strictEqual(body(para('<code><a href="#Type">Type</a></code>')), '[`Type`](#Type)',
    'a monospaced internal xref is unaffected')
  // (a2) The www FORM of the same rule. Breaking the scheme alone is not enough:
  // the `{/**/}` ends the text run, so a `www.` host that followed the `//` now
  // begins one and micromark's www-autolink rule fires on the remainder. The real
  // case is 5.4/5.3 spring/configuration -- `xmlns:hz="http://www.hazelcast.com/
  // schema/spring"` in bold prose, which the golden does not link at all. The
  // reader-visible TEXT stayed correct there, so only Layer 2 caught it, which is
  // exactly why it is worth a test: the symptom is invisible in the text diff.
  const wwwUrl = body(para('add xmlns:hz="http://www.hazelcast.com/schema/spring" to it.'))
  assert.ok(!/\]\(|\[http/.test(wwwUrl), 'no link is invented for a www host behind a scheme')
  assert.ok(!wwwUrl.includes('//www.hazelcast'), 'the www run is broken too, not left contiguous')
  // A BARE www host (no scheme) is the same hazard with nothing for SCHEME to match.
  // Faithful unconditionally: Asciidoctor does not autolink a bare www host, and no
  // anchor anywhere in the golden has link text starting `www.`.
  const bareWww = body(para('see www.hazelcast.com/pricing for details.'))
  assert.ok(!/\]\(/.test(bareWww), 'no link is invented for a bare www host either')
  // Text is preserved EXACTLY: the break renders the same characters. Oracle is the
  // input text, recovered by deleting the guards.
  for (const [out, want] of [[wwwUrl, 'add xmlns:hz="http://www.hazelcast.com/schema/spring" to it.'],
    [bareWww, 'see www.hazelcast.com/pricing for details.']]) {
    assert.strictEqual(out.replace(/\{\/\*\*\/\}/g, '').replace(/\\/g, ''), want,
      'breaking an autolink changes no reader-visible character')
  }
  ok('prose URLs: autolinks not invented, placeholders normalised to code, real links intact')
}

// --- non-heading anchors survive, and are REGISTERED -------------------------
// AsciiDoc `[[id]]` mid-content becomes an empty `<a id>` in the golden. Two things
// must hold: the id reaches the output (a dropped one is a dead link), and it is
// emitted as <Anchor>, which registers itself with Docusaurus's broken-anchor
// validation -- a raw `<span id>` resolves in the browser but is invisible to that
// check, so links to it get reported and the noise hides real breaks.
{
  const { convertBody } = require('./lib/html-to-mdx')
  const body = (html) => convertBody(html, {}).body.trim()

  // The shape that was losing anchors: management-center system-properties, where
  // the anchor sits INSIDE the cell's code span and inlineCode() read only text.
  const cell = '<p class="tableblock"><code><a id="hazelcast-mc-http-port"></a>hazelcast.mc.http.port</code></p>'
  const out = body(cell)
  assert.ok(out.includes('<Anchor id="hazelcast-mc-http-port"/>'), 'an anchor nested in code is kept')
  assert.ok(out.includes('`hazelcast.mc.http.port`'), 'and the content stays a Markdown code span')
  assert.ok(out.indexOf('<Anchor') < out.indexOf('`'), 'the anchor precedes the code it targets')

  // A bare anchor in prose: same component, so there is ONE anchor form.
  assert.ok(body('<div class="paragraph"><p><a id="step-5"></a>Then do this.</p></div>')
    .includes('<Anchor id="step-5"/>'), 'a bare anchor in prose uses the same form')
  assert.ok(!/<span id=/.test(body('<div class="paragraph"><p><a id="step-5"></a>x</p></div>')),
    'no raw <span id> is emitted any more -- it would not be registered')

  // Not an anchor: a monospaced cross-reference keeps being a link with a code
  // label, and gains no stray <Anchor>.
  const xref = body('<div class="paragraph"><p><code><a href="#Type">Type</a></code></p></div>')
  assert.strictEqual(xref, '[`Type`](#Type)', 'a code-wrapped link is unaffected')

  // Multiple anchors in one code span are all kept, in document order.
  const two = body('<p class="tableblock"><code><a id="a1"></a><a id="a2"></a>name</code></p>')
  assert.ok(two.indexOf('id="a1"') < two.indexOf('id="a2"'), 'several anchors keep source order')
  ok('inline anchors: kept (incl. nested in code) and emitted as the registered <Anchor>')
}

// --- marked attribute inside INLINE code -> JSX <code> ----------------------
// The one context neither of the other two mechanisms reaches: a code span is
// literal, so a `{name}` token in backticks stays literal, and the `vars` flag is
// a FENCE info-string flag with nowhere to live on a span. JSX <code> can hold the
// reference, and each literal run must be a JS STRING EXPRESSION -- MDX parses the
// children of a JSX element as markdown, so a bare literal would let `_`/`*` in a
// filename turn into emphasis.
{
  const marked = '<div class="paragraph"><p>Get <code>clc-setup-v<span class="hz-attr-full-version">5.5.1</span>.exe</code> now.</p></div>'
  const out = convertBody(marked, { pageUrl: '/clc/5.5.1/install-clc', component: 'clc', seg: '5.5.1' }).body
  assert.match(out, /<code>\{"clc-setup-v"\}<Variable name="full-version"\/>\{"\.exe"\}<\/code>/,
    'the reference survives inside inline code, with the literal runs inert')
  assert.ok(!out.includes('5.5.1'), 'the resolved value is not baked anywhere in the output')

  const plain = '<div class="paragraph"><p>Run <code>my_cmd --x</code>.</p></div>'
  assert.match(convertBody(plain, {}).body, /`my_cmd --x`/,
    'inline code with no marker stays ordinary Markdown backticks')
  ok('inline code: a marked reference becomes JSX <code> + <Variable>; unmarked code is untouched')
}

// --- mark-attributes context rules (the other half of that mechanism) --------
{
  const names = ['full-version']
  const wrapped = wrapRefs('Get `clc-setup-v{full-version}.exe` now.', names)
  assert.ok(wrapped.includes('{full-version}') && wrapped !== 'Get `clc-setup-v{full-version}.exe` now.',
    'a reference inside inline code IS marked (sentinels survive single-backtick monospace)')
  assert.ok(!wrapped.includes('[.hz-attr-'), 'inline code takes plain sentinels, not the heading role span')

  const heading = '== Install `clc-v{full-version}.exe`'
  assert.strictEqual(wrapRefs(heading, names), heading,
    'inline code in a HEADING is left alone: a sentinel would leak into the derived anchor id')
  ok('mark-attributes: inline code marked in flow text, skipped in headings')
}

// --- prose-eligibility: wrappableRefs gates the PROSE reverse-map -------------
// convert.js scanPageAttrs asks this predicate "does the page reference the attr
// in a context that renders into flow text?", and only then may the attribute's
// VALUE be matched in prose. The requirement: an attribute referenced solely
// inside verbatim blocks must be prose-ineligible, because there is no flow-text
// reference to restore, so any prose match on its value is a false positive
// waiting to happen (operator's operator-chart-version is `----`-fenced-only on
// get-started, and its value is a version number that could equal a literal
// anywhere on that page). Note "verbatim" here means the delimiters the marking
// pass recognises: a BACKTICK fence is read as flow text by both, so a reference
// there stays prose-eligible — deliberately, so the two never disagree.
//
// The oracle is the marking pass itself: prose-eligible must mean exactly
// "wrapRefs would have marked it", so a marker and a prose match can never
// disagree about what a flow-text context is.
{
  const fenceOnly = ['Install it:', '', '[source,bash]', '----',
    'helm install operator --version={operator-chart-version}', '----', '', 'Done.'].join('\n')
  const names = ['operator-chart-version']
  assert.ok(!wrappableRefs(fenceOnly, names).has('operator-chart-version'),
    'an attribute referenced only inside a verbatim block is NOT prose-eligible')
  assert.strictEqual(wrapRefs(fenceOnly, names), fenceOnly,
    'and marking agrees: it leaves a fence-only reference completely untouched')

  // Add one flow-text reference to the same page and it becomes eligible — the
  // predicate is about the page, not the attribute.
  const alsoProse = fenceOnly.replace('Done.', 'Chart {operator-chart-version} is current.')
  assert.ok(wrappableRefs(alsoProse, names).has('operator-chart-version'),
    'the same attribute IS prose-eligible once the page references it in flow text')

  // A LINK MACRO TARGET renders into the `href`, not into flow text, so a
  // reference there is neither markable nor prose-eligible. Both halves matter:
  // marking a target puts a <span> inside an attribute value (malformed HTML that
  // cheerio reads as a truncated URL -- it mangled 226 hazelcast javadoc links),
  // and a prose value match for an attribute the page only ever uses in a URL is
  // the false positive this predicate exists to refuse. Nothing is lost either
  // way: the link path reverse-maps `pageVars`, which this does not filter, and
  // the href-template path (buildHrefVars) recovers the reference exactly.
  const macro = 'link:https://docs.hazelcast.com/hazelcast/{page-cloud-platform-version}/x[Platform] in use.'
  assert.ok(!wrappableRefs(macro, ['page-cloud-platform-version']).has('page-cloud-platform-version'),
    'a reference inside a link macro target is not prose-eligible: it renders into an href')
  assert.strictEqual(wrapRefs(macro, ['page-cloud-platform-version']), macro,
    'and marking agrees: it leaves a link target completely untouched')

  // Both bare-autolink and `link:` forms, and only the TARGET -- a reference in
  // the same line's prose or in the link LABEL is still marked.
  const bare = 'See https://docs.hazelcast.org/docs/{os-version}/javadoc/X.html[the API] for {os-version}.'
  const markedBare = wrapRefs(bare, ['os-version'])
  assert.ok(markedBare.includes('/docs/{os-version}/javadoc'),
    'the reference in the autolink TARGET is left bare')
  assert.ok(/for .*\{os-version\}.*\./.test(markedBare) && markedBare !== bare,
    'the reference in the same line\'s PROSE is still marked')
  // An UNLABELLED autolink is the same hazard with no `[` to find it by: one source
  // occurrence renders into both the href and the visible text, so the whole thing
  // is skipped. hazelcast's clients/java writes its javadoc links this way.
  const unlabelled = '* {enterprise-product-name}: https://docs.hazelcast.org/hazelcast-ee-docs/{ee-version}/javadoc'
  const markedUnlabelled = wrapRefs(unlabelled, ['ee-version', 'enterprise-product-name'])
  assert.ok(markedUnlabelled.includes('hazelcast-ee-docs/{ee-version}/javadoc'),
    'a reference inside an unlabelled autolink is left bare')
  assert.ok(markedUnlabelled !== unlabelled,
    'while the list-item label on the same line is still marked')
  // An `include::` DIRECTIVE is machinery, not flow text: it renders nothing, and a
  // sentinel in its target breaks the resolve outright (9 "target of include not
  // found" errors when {page-latest-supported-mc} was first marked).
  const inc = 'include::{page-latest-supported-mc}@management-center:getting-started:install.adoc[tag=cli]'
  assert.strictEqual(wrapRefs(inc, ['page-latest-supported-mc']), inc,
    'an include directive is left completely untouched')
  assert.ok(!wrappableRefs(inc, ['page-latest-supported-mc']).has('page-latest-supported-mc'),
    'and an attribute reached only through an include target is not prose-eligible')
  // ANY macro target, not just a link's: an `xref:` coordinate is machine-readable
  // and marking it left Antora unable to resolve the xref at all, so the golden kept
  // the macro as literal text on 46 pages. Same for an image's target.
  const xref = 'See xref:{page-latest-supported-mc}@management-center:monitor-imdg:monitor-dds.adoc#x[MC] for {page-latest-supported-mc}.'
  const markedXref = wrapRefs(xref, ['page-latest-supported-mc'])
  assert.ok(markedXref.includes('xref:{page-latest-supported-mc}@management-center'),
    'an xref TARGET is left bare')
  assert.ok(markedXref !== xref, 'while the prose reference on the same line is still marked')
  const img = 'image:pic-{version}.png[alt] then prose {version}.'
  assert.ok(wrapRefs(img, ['version']).includes('image:pic-{version}.png['),
    "an image's target is left bare too")
  ok('prose-eligibility: verbatim blocks and macro targets are excluded, flow text is not')
}

// --- the two ways a marker can malform the golden ----------------------------
// A marker is only safe where it spanifies into flow content. The snapshot builder
// guards both failure modes, and they need different detectors: a BROKEN sentinel
// run leaves control characters behind (hasSentinelResidue), while a WELL-FORMED
// span inside an attribute value leaves none -- and, because stripAttrSpans still
// reproduces the clean golden byte-for-byte, every other faithfulness check passes
// too. That is why the second one has to be checked structurally: a well-formed tag
// never contains a `<` between its name and its `>`.
{
  const good = '<p>Version <span class="hz-attr-os-version">5.8.0-SNAPSHOT</span> is current.</p>'
  assert.ok(!hasSentinelResidue(good) && !hasAttrSpanLeak(good),
    'a span in flow content is exactly what marking is for')

  const inHref = '<a href="https://docs.hazelcast.org/docs/<span class="hz-attr-os-version">5.8.0-SNAPSHOT</span>/javadoc/X.html">API</a>'
  assert.ok(hasAttrSpanLeak(inHref), 'a span inside an attribute value must be detected')
  assert.ok(!hasSentinelResidue(inHref),
    'the residue check cannot see it -- the sentinels DID spanify, which is why a second detector exists')
  assert.strictEqual(stripAttrSpans(inHref),
    '<a href="https://docs.hazelcast.org/docs/5.8.0-SNAPSHOT/javadoc/X.html">API</a>',
    'and the strip is still byte-faithful, which is why nothing downstream noticed')

  // Not fooled by an ordinary span that merely FOLLOWS a tag with attributes.
  assert.ok(!hasAttrSpanLeak('<a href="/x" class="y">go</a> <span class="hz-attr-ucn">User Code Namespaces</span>'),
    'a span after a closed tag is flow content, not an attribute leak')
  ok('mark-attributes: a broken run and a span inside an attribute value are both caught')
}

// --- marked attrs: value reverse-map applies to CODE only, never PROSE -------
// The requirement: for a MARKED attribute, a reference must be preserved exactly
// where the source put one and NOWHERE ELSE. Marking supplies the positions for
// every non-verbatim context, so prose needs no value matching — and value
// matching in prose is actively wrong, because the same value can occur as
// literal data on the very page that references it (operator's scaling-upgrading
// compatibility matrix: at 5.12 `5.4.0` is both the attribute's value and the
// Hazelcast cell of rows 5.11/5.12). Verbatim blocks are the exception marking
// cannot reach, so code KEEPS the value map.
//
// The oracle is the source's own reference count: one marked reference in the
// prose and none in the table means exactly one <Variable> in the prose, and the
// table's literals must survive verbatim.
{
  const value = '5.4.0'
  const pageVars = new Map([[value, 'page-latest-supported-hazelcast']])
  const proseVars = new Map() // what proseVarsFor yields once the attr is marked
  const marker = `<span class="hz-attr-page-latest-supported-hazelcast">${value}</span>`
  // One genuine (marked) reference in flow text, plus the compatibility matrix
  // repeating the same version as DATA in two rows.
  const html =
    `<div class="paragraph"><p>Upgrade to ${marker}, then apply:</p></div>` +
    '<table class="tableblock"><tbody>' +
    `<tr><td class="tableblock"><p>5.11</p></td><td class="tableblock"><p>${value}</p></td></tr>` +
    `<tr><td class="tableblock"><p>5.12</p></td><td class="tableblock"><p>${value}</p></td></tr>` +
    '</tbody></table>'
  const ctx = { pageUrl: '/operator/5.12/scaling-upgrading', component: 'operator', seg: '5.12', pageVars, proseVars }
  const out = convertBody(html, ctx).body
  const refs = (out.match(/<Variable name="page-latest-supported-hazelcast"\/>/g) || []).length
  assert.strictEqual(refs, 1,
    'exactly the ONE reference the source marked becomes a <Variable> — the table data does not')
  assert.strictEqual((out.match(/5\.4\.0/g) || []).length, 2,
    'both compatibility-table cells keep the literal version they state as historical fact')

  // Contrast, same page: inside a fence marking cannot reach, so the value map
  // still applies and the fence becomes a `vars` template with no baked value.
  const fence = '<div class="listingblock"><div class="content">' +
    `<pre class="highlight"><code class="language-yaml">spec:\n  version: ${value}\n</code></pre></div></div>`
  const fenced = convertBody(fence, ctx).body
  assert.ok(/```yaml vars/.test(fenced),
    'a fence containing the value is reverse-mapped and flagged `vars`')
  assert.ok(fenced.includes('{page-latest-supported-hazelcast}') && !fenced.includes(value),
    'the fence carries the placeholder, not the resolved value')
  ok('marked attrs: prose preserves only marked references (table data stays literal); fences keep the value map')
}

// --- the verbatim-block boundary: a version token, not a whole word ----------
// Inside a fence a version is normally glued into an identifier
// (`hazelcast-management-center-5.11.0.jar`), so the whole-token rule that prose
// uses refuses it and the reference bakes. The verbatim rule is numeric instead:
// what may not be adjacent is another DIGIT, or a `.`/`-` that itself sits
// against a digit.
//
// The oracle is arithmetic, not the implementation: a version number's extent is
// its digits and dots, so `.jar` ends the number and `.0` continues it. Each case
// below is one side of that arithmetic, stated as an input a real page contains.
{
  const value = '5.11.0'
  const pageVars = new Map([[value, 'full-version']])
  const ctx = { pageUrl: '/management-center/5.11/x', component: 'management-center', seg: '5.11', pageVars, proseVars: pageVars }
  const fenced = (code) => convertBody(
    '<div class="listingblock"><div class="content">' +
    `<pre class="highlight"><code class="language-bash">${code}</code></pre></div></div>`, ctx).body

  // Glued into a filename: separated from the identifier by `-`, from the
  // extension by `.` — neither of which extends the number.
  const jar = fenced('-jar hazelcast-management-center-5.11.0.jar')
  assert.ok(jar.includes('{full-version}') && !jar.includes(value),
    'a version glued into a filename is a reference, not a literal')
  assert.ok(/```bash vars/.test(jar), 'and its fence is flagged `vars` so the placeholder resolves')

  // Same value at end of line, and after the separators that already worked —
  // the looser rule must not lose what the whole-token rule matched.
  for (const code of ['sudo yum install hazelcast-management-center-5.11.0',
    'docker pull hazelcast/management-center:5.11.0',
    'brew install hazelcast/hz/hazelcast-management-center@5.11.0']) {
    assert.ok(fenced(code).includes('{full-version}'), `still matched: ${code}`)
  }

  // A digit-extended neighbour is a DIFFERENT number and must stay literal. Both
  // are real: the first is the guard that keeps a version out of a longer one,
  // the second is MC's update-config link, where `.0` is authored after the
  // reference (`v{page-latest-supported-hazelcast}.0`).
  const longer = fenced('checksum 0.3.5.11.0f')
  assert.ok(longer.includes('0.3.5.11.0f') && !longer.includes('{full-version}'),
    'a version that is a substring of a longer number is not a reference')

  const short = new Map([['5.7', 'page-latest-supported-hazelcast']])
  const tag = convertBody('<div class="listingblock"><div class="content">' +
    '<pre class="highlight"><code class="language-bash">git checkout v5.7.0</code></pre></div></div>',
    { ...ctx, pageVars: short, proseVars: short }).body
  assert.ok(tag.includes('v5.7.0') && !tag.includes('{page-latest-supported-hazelcast}'),
    'a value continued by `.0` is not the whole version and stays literal')

  // The looser rule is scoped to verbatim blocks: in flow text the same glued
  // filename keeps the whole-token rule, so it is left alone.
  const prose = convertBody(`<div class="paragraph"><p>Run hazelcast-management-center-${value}.jar now.</p></div>`, ctx).body
  assert.ok(prose.includes(`hazelcast-management-center-${value}.jar`) && !prose.includes('<Variable'),
    'prose keeps the whole-token boundary — the looser rule is verbatim-only')
  ok('verbatim boundary: a glued version is a reference; a digit-extended one is not; prose unaffected')
}

// --- a factored partial's attribute scope comes from its consumers -----------
// A factored fragment is converted once, with no page of its own, so it needs a
// reverse-map scope. An attribute reference inside an included file resolves
// against the INCLUDING document, so the scope is the union over the pages that
// include it of what each of them may map.
//
// The oracle is set arithmetic on scanPageAttrs' own per-page sets, stated
// independently of how the union is built: a name is in scope iff SOME consumer
// has it, and in the prose scope iff some consumer has it IN PROSE.
{
  const attrsByKey = new Map([
    ['getting-started:overview', { all: new Set(['full-version', 'mc-repo-swagger-branch']), prose: new Set(['full-version']) }],
    ['integrate:jmx', { all: new Set(['full-version']), prose: new Set() }],
    ['clusters:licence', { all: new Set(['enterprise-product-name']), prose: new Set(['enterprise-product-name']) }],
  ])
  const keyForUrl = (url) => ({
    '/mc/overview': 'getting-started:overview',
    '/mc/jmx': 'integrate:jmx',
    '/mc/licence': 'clusters:licence',
  })[url] || null

  const two = consumerAttrs(['/mc/overview', '/mc/licence'], keyForUrl, attrsByKey)
  assert.deepStrictEqual([...two.all].sort(), ['enterprise-product-name', 'full-version', 'mc-repo-swagger-branch'],
    'a name is in scope if ANY including page may map it')
  assert.deepStrictEqual([...two.prose].sort(), ['enterprise-product-name', 'full-version'],
    'the prose scope unions only the prose sets — a verbatim-only name stays out of prose')

  // jmx references full-version ONLY inside fences, so a fragment shared with it
  // alone may template a fence but must not prose-match.
  const fenceOnly = consumerAttrs(['/mc/jmx'], keyForUrl, attrsByKey)
  assert.deepStrictEqual([...fenceOnly.all], ['full-version'], 'the value map still carries it (fences need it)')
  assert.strictEqual(fenceOnly.prose.size, 0, 'but prose matching is not permitted on a verbatim-only reference')

  // A consumer we know nothing about widens nothing — the guard fails CLOSED, so
  // an unscanned page cannot cause a literal to be variableised.
  const unknown = consumerAttrs(['/mc/not-scanned', '/mc/jmx'], keyForUrl, attrsByKey)
  assert.deepStrictEqual([...unknown.all], ['full-version'], 'an unknown consumer contributes nothing')
  assert.strictEqual(consumerAttrs(undefined, keyForUrl, attrsByKey).all.size, 0, 'no consumers -> empty scope')

  // And the decision record must actually carry the consumers, or convert.js has
  // nothing to derive the scope from.
  const one = { id: 'c:ROOT:partial$p.adoc', inner: '<p>same</p>', blockLevel: true }
  const { decisions } = decide([{ url: '/a', occ: [one] }, { url: '/b', occ: [one] }], 'c')
  assert.deepStrictEqual(decisions.get('c:ROOT:partial$p.adoc').pages, ['/a', '/b'],
    'a factored decision carries the pages that include it')
  ok('factored partials: attribute scope is the union of the including pages\' own scopes')
}

// --- href templates: recovering a reference the author wrote text after --------
// `link:…/tree/v{ver}.0/…` and `link:{console}settings/developer` cannot be
// recovered by matching the resolved value in the finished URL: the matcher would
// have to decide that `.0` continues the URL but not the version, and the rule
// that makes it safe elsewhere (varCodeTokenRe) must refuse exactly this. The
// template comes from the source instead, and the match is string equality.
//
// The oracle is the substituter the site itself uses: filling the version's values
// into the extracted template must reproduce the href Antora wrote, so the pair
// (template, resolved) is checked against `substitute`, not against a fixture.
{
  const src = [
    '- link:https://github.com/hazelcast/hazelcast/tree/v{page-latest-supported-hazelcast}.0/x/full-example.xml[XML example]',
    '- https://github.com/hazelcast/hazelcast/tree/v{page-latest-supported-hazelcast}.0/x/full-example.yaml[YAML example]',
    'Keys live in the link:{page-cloud-console}settings/developer[console].',
    'See xref:{page-latest-supported-mc}@management-center::index.adoc[MC].',
    'A plain link:https://example.com/nothing[label].',
  ].join('\n')
  const tpls = [...attrHrefTemplates(src)]
  assert.strictEqual(tpls.length, 3, 'both link forms and the prefix form are targets; xref and attribute-free links are not')
  assert.ok(tpls.every((t) => /\{[a-z-]+\}/.test(t)), 'every extracted target carries a reference')
  assert.ok(!tpls.some((t) => t.includes('management-center')),
    'xref targets are excluded — their attribute is a version COORDINATE, resolved by Antora')

  // Round-trip through the real substituter: template + values === the golden href.
  const lookup = { 'page-latest-supported-hazelcast': '5.7', 'page-cloud-console': 'https://cloud.hazelcast.com/' }
  const xml = tpls.find((t) => t.endsWith('.xml'))
  assert.strictEqual(substitute(xml, lookup),
    'https://github.com/hazelcast/hazelcast/tree/v5.7.0/x/full-example.xml',
    'the template resolves to exactly the href Antora rendered')

  // Given that map, the converter emits the template — and the LABEL keeps its own
  // (different) reference, which an href-only substitution would have dropped.
  const hrefVars = new Map([[substitute(xml, lookup), xml]])
  const pageVars = new Map([['5.11.0', 'full-version']])
  const html = '<div class="paragraph"><p><a href="https://github.com/hazelcast/hazelcast/tree/v5.7.0/x/full-example.xml">Example for 5.11.0</a></p></div>'
  const out = convertBody(html, { pageUrl: '/management-center/5.11/x', component: 'management-center', seg: '5.11', hrefVars, pageVars, proseVars: pageVars }).body
  assert.ok(out.includes('href="https://github.com/hazelcast/hazelcast/tree/v{page-latest-supported-hazelcast}.0/x/full-example.xml"'),
    'the href is emitted as the source template, references intact')
  assert.ok(out.includes('{full-version}') && !out.includes('5.11.0'),
    'and the label is still templated — the href path must not bypass the label')
  assert.ok(!out.includes('v5.7.0'), 'no resolved version is left baked in the href')

  // An href with no matching template is untouched by this path.
  const other = convertBody('<div class="paragraph"><p><a href="https://example.com/x">x</a></p></div>',
    { pageUrl: '/management-center/5.11/x', component: 'management-center', seg: '5.11', hrefVars }).body
  assert.ok(other.includes('https://example.com/x'), 'an unrelated href is left alone')
  ok('href templates: a reference followed by authored text is recovered from the source, label included')
}

// --- nav labels: attributes are BAKED, deliberately --------------------------
// Everything the nav produces lands in YAML — a page's frontmatter
// `sidebar_label:` and a category's `_category_.json` label — and nothing
// interpolates YAML, so a surviving `{name}` reaches the reader as literal
// braces. Antora resolves these when it renders the nav; the converter reads
// nav.adoc raw and so must resolve them itself.
{
  const nav = '.Manage {hazelcast-cloud}\n* xref:connect.adoc[Connect to {hazelcast-cloud}]\n'
  const lookup = { 'hazelcast-cloud': 'Cloud' }
  const roots = parseNav(substitute(nav, lookup))
  assert.strictEqual(roots[0].label, 'Manage Cloud', 'a category label is resolved')
  assert.strictEqual(roots[0].children[0].label, 'Connect to Cloud', 'a page label is resolved')

  const raw = parseNav(nav)
  assert.ok(raw[0].children[0].label.includes('{hazelcast-cloud}'),
    'without the substitution the token would survive into frontmatter (the defect refcheck reports as `inert`)')
  assert.strictEqual(substitute('Keep {not-an-attribute}', lookup), 'Keep {not-an-attribute}',
    'an unknown name is left literal, as Antora leaves an undefined attribute')
  ok('nav labels: attribute references are resolved before they become YAML')
}

// --- swagger_ui:: block macro -> <ApiReference> ------------------------------
// The golden render does not load the swagger-ui extension (see the
// `extensions:` note in antora/index-playbook.yml), so the macro survives as
// literal paragraph text. The requirement has two halves, both checked against
// independent oracles rather than against the emitted string:
//   1. ROUND TRIP -- substituting the version's attribute values back into the
//      emitted `source` must reproduce the macro target byte-for-byte, using the
//      same substituter the build-time plugin/loader uses. Anything the converter
//      dropped, re-encoded or mis-bounded shows up as a URL that differs.
//   2. THE GATE'S OWN COUNTER -- refcheck decides whether the attribute stayed a
//      reference. Asking countMdxRefs (the gate's function) rather than grepping
//      for `{name}` means the test cannot pass while the gate fails.
{
  const { countMdxRefs } = require('../refcheck/lib/mdx-refs')
  const macro = (target) => `<div class="paragraph"><p>swagger_ui::${target}[]</p></div>`
  const tpl = 'https://github.com/hazelcast/management-center/blob/{mc-repo-swagger-branch}/hazelcast-management-center/src/openapi/external/rest-client-api.yaml'

  // Every live MC version, including the snapshot line whose value is the
  // generic word `master` -- the boundary rule has to accept it between slashes.
  for (const value of ['5.11.0', '5.10.0', '5.9.0', 'master']) {
    const resolved = substitute(tpl, { 'mc-repo-swagger-branch': value })
    const ctx = { pageUrl: '/management-center/x/integrate/client-filtering', pageVars: new Map([[value, 'mc-repo-swagger-branch']]) }
    const { body, imports } = convertBody(macro(resolved), ctx)

    const src = body.match(/<ApiReference\s+source="([^"]+)"\s*\/>/)
    assert.ok(src, `the macro converts to <ApiReference> (value ${value})`)
    assert.strictEqual(substitute(src[1], { 'mc-repo-swagger-branch': value }), resolved,
      `resolving the emitted source reproduces the macro target verbatim (value ${value})`)
    assert.strictEqual(countMdxRefs(body, 'mc-repo-swagger-branch'), 1,
      `refcheck counts exactly one surviving reference (value ${value})`)
    assert.strictEqual(imports.size, 0, 'ApiReference is globally registered, so no import is emitted')
    assert.ok(!/swagger_ui/.test(body), 'no trace of the macro text is left in the output')
  }
  ok('swagger_ui:: -> <ApiReference>, target round-trips, attribute stays a reference')

  // With no page vars the target is emitted verbatim: the converter never
  // invents a reference, it only restores one the page's source really has.
  const bare = 'https://github.com/hazelcast/management-center/blob/master/x/y.yaml'
  assert.ok(convertBody(macro(bare), { pageUrl: '/x' }).body.includes(`source="${bare}"`),
    'an unmapped target is emitted verbatim')

  // Negatives: only a paragraph that is ENTIRELY the macro converts. Prose that
  // merely mentions it, and a macro carrying attributes (a shape the corpus does
  // not use, so converting it would be a guess), stay on the paragraph path.
  const para = (text) => `<div class="paragraph"><p>${text}</p></div>`
  assert.ok(!/<ApiReference/.test(convertBody(para('The swagger_ui::https://x/y.yaml[] macro publishes a spec.'), { pageUrl: '/x' }).body),
    'a paragraph that merely mentions the macro is not converted')
  assert.ok(!/<ApiReference/.test(convertBody(para('swagger_ui::https://x/y.yaml[title=API]'), { pageUrl: '/x' }).body),
    'a macro carrying attributes is left on the paragraph path for the gates to flag, not guessed at')
  ok('swagger_ui:: negatives: only a whole-paragraph, attribute-less macro converts')
}

// --- repairApiDeepLink: restore, then retarget, a link into an API page -------
// Asciidoctor's subscript substitution eats the `~` pairs out of a JSON-pointer
// deep link into an API reference, so the golden href carries <sub> elements.
// The requirement is stated against json-pointer itself: after unmangling, the
// fragment must PARSE as the pointer the author wrote, i.e. back to the spec
// path and HTTP verb. A test that compared strings would only restate the regex.
{
  const jsonPointer = require('json-pointer')
  const authored = '#/paths/~1rest~1clusters~1%7Bcluster%7D~1clientfiltering~1lists/post'
  const mangled = '#/paths/<sub>1rest</sub>1clusters<sub>1%7Bcluster%7D</sub>1clientfiltering~1lists/post'

  assert.strictEqual(unmangleSubscripts(mangled), authored,
    'the golden href is restored to the target the author wrote')
  assert.deepStrictEqual(
    jsonPointer.parse(decodeURIComponent(unmangleSubscripts(mangled).replace(/^#/, ''))),
    ['paths', '/rest/clusters/{cluster}/clientfiltering/lists', 'post'],
    'and it parses as the spec pointer for that path + verb (json-pointer oracle)')

  // Idempotent, and a no-op on everything else -- `<`/`>` are illegal in a URL,
  // so nothing that is a real href can be touched.
  assert.strictEqual(unmangleSubscripts(authored), authored, 'an already-correct target is unchanged')
  for (const href of ['../integrate/client-filtering', '/a/b#operation/createFilteringRules',
    'https://example.com/x?a=1&b=2', '#section-title', '']) {
    assert.strictEqual(unmangleSubscripts(href), href, `left alone: ${JSON.stringify(href)}`)
  }
  ok('unmangleSubscripts: the mangled pointer parses back to its path + verb')

  // Step 2 -- retarget. The pointer is not an anchor the page publishes, so the
  // converted link must carry the SITE's anchor for that operation. Oracle: the
  // anchor is recomputed from the path and verb that json-pointer independently
  // parsed out of the authored fragment, via the same module the page renders
  // its heading ids from -- so a converter that retargeted to the wrong
  // operation, or to a string the page does not publish, fails here.
  const { operationAnchor } = require('../../plugins/lib/api-anchors')
  const [, parsedPath, parsedVerb] = jsonPointer.parse(
    decodeURIComponent(unmangleSubscripts(mangled).replace(/^#/, '')))
  assert.strictEqual(repairApiDeepLink(`../integrate/client-filtering${mangled}`),
    `../integrate/client-filtering#${operationAnchor(parsedVerb, parsedPath)}`,
    'the pointer is retargeted to the anchor the page publishes for that path + verb')

  // Retargeting is scoped to operation pointers and leaves every other fragment
  // alone -- including a `/paths/` fragment whose last segment is not a method.
  for (const href of ['../x#section-title', '../x#operation/createFilteringRules', '../x',
    '../x#/paths/~1rest~1clusters/notamethod', 'https://example.com/a#frag']) {
    assert.strictEqual(repairApiDeepLink(href), href, `left alone: ${JSON.stringify(href)}`)
  }
  ok('repairApiDeepLink: only an operation pointer is retargeted, to the published anchor')

  // End to end through the converter: the deep link on management-center
  // clusters/create-filter-lists-rest lands on the readable anchor.
  const html = `<div class="paragraph"><p>Use the <a href="${mangled.replace('#', '../integrate/client-filtering#')}"><code>/clientfiltering/lists</code></a> endpoint.</p></div>`
  const { body } = convertBody(html, { pageUrl: '/management-center/5.11/clusters/create-filter-lists-rest' })
  assert.ok(body.includes('#post-rest-clusters-cluster-clientfiltering-lists'),
    'the converted link carries the published operation anchor')
  assert.ok(!/sub%3E|<sub>|~1|\/paths\//.test(body),
    'and no trace of the pointer or the subscript markup, encoded or not')
  ok('deep link: the converted href lands on the published operation anchor')
}


// --- image references follow the placement plan ------------------------------
// The requirement: whatever path the plan gives an image, the emitted reference
// must be that same FILE seen from the consuming page -- so an independent
// oracle (resolve the emitted relative path against the page's own directory)
// must reproduce the planned destination exactly, from any depth. Getting this
// wrong yields a path that still resolves for SOME page, which is why it needs
// a real check rather than a fixed expected string.
{
  const path = require('node:path')
  const plan = new Map([
    ['/mc/5.11/_images/Dashboard.png', 'cluster/images/Dashboard.png'],
    ['/mc/5.11/_images/Root.png', 'images/Root.png'],
  ])
  const emit = (relFile, pageUrl, src) => {
    const { body } = convertBody(`<div class="imageblock"><div class="content"><img src="${src}" alt="a"></div></div>`,
      { pageUrl, relFile, component: 'mc', seg: '5.11', imagePlacement: plan })
    return body.match(/\]\(([^)]*)\)/)[1]
  }
  const resolveFrom = (relFile, ref) => path.posix.normalize(path.posix.join(path.posix.dirname(relFile), ref))

  for (const [relFile, url, planned] of [
    ['cluster/dashboard.mdx', '/mc/5.11/cluster/dashboard', 'cluster/images/Dashboard.png'],
    ['cluster/administration/persistence/backup.mdx', '/mc/5.11/cluster/administration/persistence/backup', 'cluster/images/Dashboard.png'],
    ['index.mdx', '/mc/5.11/', 'cluster/images/Dashboard.png'],
  ]) {
    const ref = emit(relFile, url, '/mc/5.11/_images/Dashboard.png')
    assert.strictEqual(resolveFrom(relFile, ref), planned,
      `from ${relFile} the reference must resolve to the planned file, not just to something`)
    assert(ref.startsWith('.'), 'a co-located reference must be relative, so webpack resolves and hashes it')
  }

  // A SPLICED conditional branch is converted from another version's golden with
  // this page's context, so its image URLs carry the DONOR's segment. Same
  // image, so it must find the same planned destination.
  const donor = emit('cluster/dashboard.mdx', '/mc/5.11/cluster/dashboard', '/mc/5.10/_images/Dashboard.png')
  assert.strictEqual(resolveFrom('cluster/dashboard.mdx', donor), 'cluster/images/Dashboard.png',
    "a donor version's image URL resolves through this version's plan")

  // No plan (or an image the plan does not cover) must NOT invent a path: the
  // site-absolute src is left alone so the build's onBrokenMarkdownImages
  // rejects it, rather than a wrong relative path resolving silently.
  const unplanned = emit('cluster/dashboard.mdx', '/mc/5.11/cluster/dashboard', '/mc/5.11/_images/Absent.png')
  assert.strictEqual(unplanned, '/mc/5.11/_images/Absent.png', 'an unplanned image is left as-is, not guessed')
  ok('imageSrc: emits the planned file as a relative path, from any depth, donor segs included')
}


// --- tab group syncing -------------------------------------------------------
// The requirement (lib/tabs.js): two tabsets on the SAME axis share a selection,
// tabsets on different axes do not. Docusaurus implements that purely through
// `groupId`, so the spec is a statement about which of the corpus's tabsets map
// to one id.
//
// The oracle is the corpus itself: every distinct tab-value signature in the
// migrated docs, each labelled with the axis a reader would say it is on. That
// is an independent statement of intent -- it says nothing about how tabs.js
// decides, only what the answer has to be -- so a broken alias or family table
// shows up as a signature landing in the wrong bucket.
{
  // [signature, axis]. axis === null means "syncs only with itself".
  // Signatures are as the sources slug them, inconsistencies included: that
  // inconsistency is exactly what has to be normalised away.
  const corpus = [
    [['linux-and-mac', 'windows'], 'os'],
    [['mac', 'linux', 'windows'], 'os'],
    [['windows', 'install-script-linux-macos'], 'os'],
    [['clc', 'java', 'nodejs', 'go', 'python', 'net'], 'language'],
    [['clc', 'java', 'nodejs', 'go', 'python'], 'language'],
    [['java', 'node-js', 'go', 'python'], 'language'],
    [['java', 'python', 'net', 'cli-clc'], 'language'],
    [['xml', 'yaml'], 'config-format'],
    [['java', 'xml', 'yaml'], 'config-format'],
    [['ui', 'mc-conf'], 'mc-config'],
    [['ui', 'hz-mc-conf'], 'mc-config'],
    [['aws', 'gcp', 'azure'], 'cloud'],
    [['kubernetes', 'openshift'], 'k8s'],
    [['hazelcast', 'management-center'], 'product'],
    [['hazelcast'], 'product'],
    [['s3', 'gcs', 'abs'], 'storage'],
    [['executor-service', 'durable-executor-service', 'scheduled-executor-service'], null],
    [['bucket-configuration', 'hotbackup-resource-name'], null],
    [['configmap', 'secret'], null],
    [['cluster-wide-installation', 'restricted-installation'], null],
    [['https', 'ssh'], null],
    [['non-interactive-mode', 'interactive-mode'], null],
    [['open-source', 'enterprise'], null],
    [['email', 'github', 'google'], null],
    [['development-cluster', 'production-cluster'], null],
  ]

  const resolved = corpus.map(([values, axis]) => {
    const normalized = normalizeValues(values)
    return { values, axis, normalized, groupId: groupIdFor(normalized) }
  })

  // 1. Same axis -> same groupId. Without this, switching one tabset leaves its
  //    siblings on the page behind -- the bug this exists to fix.
  const byAxis = new Map()
  for (const r of resolved) {
    if (r.axis === null) continue
    if (!byAxis.has(r.axis)) byAxis.set(r.axis, [])
    byAxis.get(r.axis).push(r)
  }
  for (const [axis, members] of byAxis) {
    const ids = new Set(members.map((m) => m.groupId))
    assert.strictEqual(ids.size, 1,
      `every tabset on the ${axis} axis must share one groupId, got ${[...ids].join(', ')}`)
  }

  // 2. Different axes -> different groupIds, and a self-only signature shares
  //    with nothing. Switching "XML" must not move a Kubernetes/OpenShift tabset.
  const owner = new Map()
  for (const r of resolved) {
    const claim = r.axis === null ? Symbol('self') : r.axis
    const prev = owner.get(r.groupId)
    if (prev !== undefined) {
      assert.strictEqual(prev, claim,
        `groupId ${r.groupId} is claimed by two different axes -- [${r.values.join(', ')}] would sync with an unrelated tabset`)
    }
    owner.set(r.groupId, claim)
  }

  // 3. A shared groupId is only USEFUL where the groups have a value in common:
  //    Docusaurus falls back to a group's own default when the stored value is
  //    absent from it. So members of an axis must overlap pairwise-transitively
  //    -- every member shares at least one value with some other member.
  for (const [axis, members] of byAxis) {
    if (members.length < 2) continue
    for (const m of members) {
      const overlaps = members.some((o) => o !== m && o.normalized.some((v) => m.normalized.includes(v)))
      assert(overlaps,
        `[${m.values.join(', ')}] shares groupId ${axis} but no value with any sibling, so the sync can never fire`)
    }
  }

  // 4. Docusaurus's own constraint (ensureNoDuplicateValue in
  //    theme-common/utils/tabsUtils): values within one <Tabs> must be unique.
  //    Normalisation must not break that -- an alias that merges two tabs of the
  //    SAME tabset would throw at render time.
  for (const r of resolved) {
    assert.strictEqual(new Set(r.normalized).size, r.normalized.length,
      `normalising [${r.values.join(', ')}] must keep every value distinct`)
  }
  ok('tabs: same-axis tabsets share a groupId, different axes do not, and every group overlaps (corpus oracle)')
}

// A colliding alias must FAIL rather than emit a <Tabs> Docusaurus throws on.
{
  assert.throws(() => normalizeValues(['mc-conf', 'hz-mc-conf']), /collides/,
    'an alias that merges two tabs of one tabset must be rejected, not emitted')
  // A signature matching TWO families identifies no axis, so it joins neither
  // rather than being assigned to whichever is declared first. `java` is the only
  // such signature the vocabularies allow (client-language n config-format), and
  // it occurs as a lone `Java::` tabset, which has nothing to sync anyway.
  assert.strictEqual(groupIdFor(['java']), 'java',
    'a signature matching two families must join neither, not be assigned to one')
  // The fallback must not swallow a LONE value that only one family claims: one
  // value identifies an axis when nothing else offers it.
  assert.strictEqual(groupIdFor(['hazelcast']), 'product',
    'a lone value unique to one family still joins that family')
  ok('tabs: a colliding alias is a hard error; an unplaceable family match declines to sync')
}

// End to end through the real converter: the emitted <Tabs> carries the groupId
// its (normalised) values imply, the LABELS survive verbatim -- normalisation
// renames the machine-readable value only, never what the reader sees -- and the
// pane bodies stay with their own tab.
{
  const tabset = (n, tabs) =>
    `<div class="tabset is-loading"><div class="ulist tabs"><ul>` +
    tabs.map(([v, l]) => `<li><p><a id="tabset${n}_${v}"></a>${l}</p></li>`).join('') +
    `</ul></div><div class="content">` +
    tabs.map(([v, , body]) => `<div class="tab-pane" aria-labelledby="tabset${n}_${v}"><div class="paragraph"><p>${body}</p></div></div>`).join('') +
    `</div></div>`

  const { body } = convertBody(
    tabset(1, [['ui', 'UI', 'click it'], ['hz-mc-conf', 'hz-mc-conf', 'type it']]), { pageUrl: '/x' })

  assert.match(body, /<Tabs groupId="mc-config-method">/,
    'the emitted tabset must carry the groupId of its axis')
  assert.match(body, /<TabItem value="mc-conf" label="hz-mc-conf">/,
    "the value is normalised for syncing but the label is the source's, verbatim")
  const panes = [...body.matchAll(/<TabItem value="([^"]*)"[^>]*>\s*([^<]*?)\s*<\/TabItem>/g)]
    .map((m) => [m[1], m[2]])
  assert.deepStrictEqual(panes, [['ui', 'click it'], ['mc-conf', 'type it']],
    'each pane body must stay with its own tab, in source order')

  // Two tabsets on one page, differently slugged by their authors, must come out
  // with one groupId -- the mc-conf page's actual bug.
  const two = convertBody(
    tabset(1, [['linux-and-mac', 'Linux and Mac', 'a'], ['windows', 'Windows', 'b']]) +
    tabset(2, [['windows', 'Windows', 'c'], ['install-script-linux-macos', 'Install Script (Linux/macOS)', 'd']]),
    { pageUrl: '/x' }).body
  const ids = [...two.matchAll(/<Tabs groupId="([^"]*)">/g)].map((m) => m[1])
  assert.deepStrictEqual(ids, ['os', 'os'], 'both OS tabsets on the page must share one groupId')
  ok('tabs: convertBody emits the groupId, normalises values, and keeps labels + pane bodies intact')
}

// Nested block content converts the same way wherever it sits. `blockOrInline`
// (table cells, admonition bodies, description-list <dd>s) has to decide whether
// a container's children are blocks, and it used to answer from its OWN copy of
// the block vocabulary -- which had drifted from the one convertBlock dispatches
// on. `tabset` was missing, so a `[tabs]` block inside a table cell (hazelcast
// storage/configuring-persistence) came out as the tab labels run together
// followed by multi-line `code spans`: not merely wrong, but invalid MDX that
// failed the build.
//
// Differential oracle, in the style of the link classifiers above: for EVERY name
// in the shared vocabulary, converting a minimal block of that kind at top level
// and inside a table cell must produce the same block -- the two paths cannot
// disagree about what a block is. A name added to BLOCK_TAGS/BLOCK_CLASSES with
// no fixture here fails, so the vocabulary cannot grow untested.
{
  const P = '<div class="paragraph"><p>hi</p></div>'
  const fixtures = {
    paragraph: P,
    ulist: '<div class="ulist"><ul><li><p>a</p></li></ul></div>',
    olist: '<div class="olist"><ol><li><p>a</p></li></ol></div>',
    dlist: '<div class="dlist"><dl><dt>t</dt><dd><p>d</p></dd></dl></div>',
    colist: '<div class="colist arabic"><table><tr><td>1</td><td>note</td></tr></table></div>',
    listingblock: '<div class="listingblock"><div class="content"><pre class="highlight">' +
      '<code class="language-xml">&lt;a&gt;</code></pre></div></div>',
    literalblock: '<div class="literalblock"><div class="content"><pre>lit</pre></div></div>',
    literal: '<div class="literal"><pre>lit</pre></div>',
    admonitionblock: '<div class="admonitionblock note"><table><tr><td class="icon"></td>' +
      '<td class="content">careful</td></tr></table></div>',
    imageblock: '<div class="imageblock"><div class="content"><img src="_images/x.png" alt="x"></div></div>',
    tabset: '<div class="tabset is-loading"><div class="ulist tabs"><ul><li><p>' +
      '<a id="tabset1_xml"></a>XML</p></li></ul></div><div class="content">' +
      '<div class="tab-pane" aria-labelledby="tabset1_xml">' + P + '</div></div></div>',
    openblock: '<div class="openblock"><div class="content">' + P + '</div></div>',
    exampleblock: '<div class="exampleblock"><div class="content">' + P + '</div></div>',
    sidebarblock: '<div class="sidebarblock"><div class="content">' + P + '</div></div>',
    quoteblock: '<div class="quoteblock"><blockquote>q</blockquote></div>',
    verseblock: '<div class="verseblock"><pre class="content">v</pre></div>',
    sect1: '<div class="sect1"><h2 id="s">S</h2><div class="sectionbody">' + P + '</div></div>',
    sect2: '<div class="sect2"><h3 id="s2">S2</h3>' + P + '</div>',
    sect3: '<div class="sect3"><h4 id="s3">S3</h4>' + P + '</div>',
    sect4: '<div class="sect4"><h5 id="s4">S4</h5>' + P + '</div>',
    sect5: '<div class="sect5"><h6 id="s5">S5</h6>' + P + '</div>',
    ul: '<ul><li><p>a</p></li></ul>',
    ol: '<ol><li><p>a</p></li></ol>',
    table: '<table class="tableblock"><tbody><tr><td class="tableblock">' +
      '<p class="tableblock">c</p></td></tr></tbody></table>',
    pre: '<pre>raw</pre>',
    details: '<details><summary class="title">S</summary><div class="content">' + P + '</div></details>',
    // Synthetic: the vocabulary entry is built by collapseSentinels from these
    // marker comments, so the fixture is the MARKED form the golden carries.
    hzifsnapshot: '<!--hz-if:snapshot:start-->' + P + '<!--hz-if:snapshot:end-->',
    hzifnotsnapshot: '<!--hz-ifnot:snapshot:start-->' + P + '<!--hz-ifnot:snapshot:end-->',
  }
  // An AsciiDoc (`a|`) cell: its blocks sit in a `.content` wrapper, which is
  // exactly the container blockOrInline is handed.
  const inCell = (html) =>
    '<table class="tableblock"><tbody><tr><td class="tableblock"><div class="content">' +
    html + '</div></td></tr></tbody></table>'

  for (const name of [...BLOCK_CLASSES, ...BLOCK_TAGS]) {
    const html = fixtures[name]
    assert(html, `no fixture for block vocabulary entry "${name}" -- add one`)
    const direct = convertBody(html, { pageUrl: '/x' }).body.trim()
    assert(direct !== '', `fixture for "${name}" converted to nothing`)
    const celled = convertBody(inCell(html), { pageUrl: '/x' }).body.trim()
    assert(celled.includes(direct),
      `a ${name} block inside a table cell must convert as a BLOCK, as it does at top level.\n` +
      `  top level: ${JSON.stringify(direct)}\n  in a cell: ${JSON.stringify(celled)}`)
  }
  ok('nested blocks: every block-vocabulary entry converts identically in a cell and at top level')
}

// A single-sourced link destination must survive being WRAPPED IN CODE.
// Asciidoctor renders a monospaced link as `<code><a href>label</a></code>`
// (hazelcast's Maven-artifact table columns: `link:…/{os-version}/jar[artifact]`
// in a `[cols="l"]` column), and that branch used to emit the RESOLVED url in a
// Markdown link — baking the version, invisibly to fidelity because a baked value
// renders identically to the reference it replaced.
//
// The requirement is that the two paths agree: whatever the plain `<a>` keeps as a
// reference, the code-wrapped one keeps too. So the oracle is the plain form's own
// output — same ladder, same href template, differing only by the `code` flag.
{
  const url = 'https://search.maven.org/artifact/com.hazelcast/hazelcast/5.8.0-SNAPSHOT/jar'
  const tpl = 'https://search.maven.org/artifact/com.hazelcast/hazelcast/{os-version}/jar'
  const st = { pageUrl: '/x', hrefVars: new Map([[url, tpl]]), pageVars: new Map() }
  const plain = convertBody(`<p><a href="${url}">hazelcast</a></p>`, st).body.trim()
  const coded = convertBody(`<p><code><a href="${url}">hazelcast</a></code></p>`, st).body.trim()

  assert.strictEqual(plain, `<Variable href="${tpl}" text="hazelcast"/>`,
    'the plain link keeps the source template as its href')
  assert.strictEqual(coded, `<Variable href="${tpl}" text="hazelcast" code/>`,
    'and so does the code-wrapped link, plus `code` so the label stays monospace')
  assert.strictEqual(coded.replace(' code/>', '/>'), plain,
    'the two forms differ ONLY by the code flag: neither may bake what the other keeps')

  // Nothing single-sourced about it -> the Markdown link with a code label, as before.
  assert.strictEqual(
    convertBody('<p><code><a href="/hazelcast/5.8-snapshot/sql/select">SELECT</a></code></p>',
      { pageUrl: '/x' }).body.trim(),
    '[`SELECT`](/hazelcast/5.8-snapshot/sql/select)',
    'an ordinary code-wrapped link is still a Markdown link with a code label')
  ok('code-wrapped links: a single-sourced destination stays a reference, exactly as a plain link does')
}

// --- code templates: keeping the right NAME inside a fence ---------------------
// The requirement the value reverse-map cannot meet: hazelcast holds
// `5.8.0-SNAPSHOT` in {os-version}, {ee-version} AND {full-version} at once, so a
// value does not identify an attribute — and the three genuinely diverge (at 5.5,
// os-version is 5.5.0 while ee-version is 5.5.10), so guessing prints the wrong
// version. The oracle is therefore the SOURCE's own text: whatever the source
// wrote is what must come back.
{
  const lookup = {'os-version': '5.8.0-SNAPSHOT', 'ee-version': '5.8.0-SNAPSHOT', 'minimum-java-version': '17'}
  const known = new Set(Object.keys(lookup))
  const build = (src) => buildCodeTemplates(attrCodeTemplates(src), known, lookup, substituteAttrs)

  // 1. Extraction: only VERBATIM lines, and a block is keyed whole as well as by line.
  const src = [
    'Prose mentioning {os-version} is not a code template.',
    '',
    '[source,xml,subs="attributes+"]',
    '----',
    '  <artifactId>hazelcast-enterprise</artifactId>',
    '  <version>{ee-version}</version>',
    '----',
    '',
    '....',
    'docker run hazelcast/hazelcast:{os-version}',
    '....',
  ].join('\n')
  const t = attrCodeTemplates(src)
  assert.deepStrictEqual([...t.lines].sort(),
    ['  <version>{ee-version}</version>', 'docker run hazelcast/hazelcast:{os-version}'].sort(),
    'only lines INSIDE a verbatim block are templates; prose is not')
  assert.ok([...t.blocks].some((b) => b.includes('<artifactId>') && b.includes('{ee-version}')),
    'a block is also keyed whole, so its non-attribute lines can disambiguate it')

  // 2. Round trip: a rendered line maps back to the source line that produced it.
  const { lines } = build(src)
  assert.strictEqual(lines.get('docker run hazelcast/hazelcast:5.8.0-SNAPSHOT'),
    'docker run hazelcast/hazelcast:{os-version}',
    'the resolved line keys the template that produced it')

  // 3. THE POINT: two same-valued attributes stay apart. Same page, two blocks,
  //    identical `<version>` lines — the LINE tier must refuse (ambiguous) while
  //    the BLOCK tier resolves both, because the artifactId lines differ.
  const both = [
    '[source,xml,subs="attributes+"]', '----',
    '  <artifactId>hazelcast</artifactId>', '  <version>{os-version}</version>', '----',
    '[source,xml,subs="attributes+"]', '----',
    '  <artifactId>hazelcast-enterprise</artifactId>', '  <version>{ee-version}</version>', '----',
  ].join('\n')
  const two = build(both)
  assert.strictEqual(two.lines.get('  <version>5.8.0-SNAPSHOT</version>'), undefined,
    'a line two different templates resolve to is dropped, never guessed')
  assert.strictEqual(
    two.blocks.get('  <artifactId>hazelcast</artifactId>\n  <version>5.8.0-SNAPSHOT</version>'),
    '  <artifactId>hazelcast</artifactId>\n  <version>{os-version}</version>',
    'the block keeps {os-version}')
  assert.strictEqual(
    two.blocks.get('  <artifactId>hazelcast-enterprise</artifactId>\n  <version>5.8.0-SNAPSHOT</version>'),
    '  <artifactId>hazelcast-enterprise</artifactId>\n  <version>{ee-version}</version>',
    'and the sibling block keeps {ee-version} — which no value-keyed map could do')

  // 4. A name the site does not single-source must not be templated: emitting its
  //    `{name}` would put literal braces in a code block.
  const unknownAttr = ['....', 'chart --version={operator-chart-version}', '....'].join('\n')
  assert.strictEqual(build(unknownAttr).lines.size, 0,
    'a template naming an attribute outside the known set is dropped')
  ok('code templates: a fence keeps the source\'s own attribute NAME, and refuses to guess when two collide')
}

// End to end: the fence converter tries the block tier before the line tier, and a
// templated line is not offered to the value map afterwards.
{
  const fence = (code, lang = 'xml') =>
    `<div class="listingblock"><div class="content"><pre class="highlight">` +
    `<code class="language-${lang}">${code}</code></pre></div></div>`
  const blocks = new Map([[
    '<artifactId>hazelcast-enterprise</artifactId>\n<version>5.8.0-SNAPSHOT</version>',
    '<artifactId>hazelcast-enterprise</artifactId>\n<version>{ee-version}</version>',
  ]])
  const body = convertBody(
    fence('&lt;artifactId&gt;hazelcast-enterprise&lt;/artifactId&gt;\n&lt;version&gt;5.8.0-SNAPSHOT&lt;/version&gt;'),
    // codeValueVars deliberately maps the same value to a DIFFERENT name: if the
    // value map ran on a templated line it would overwrite the template's answer.
    {pageUrl: '/x', codeVars: {blocks, lines: new Map()}, codeValueVars: new Map([['5.8.0-SNAPSHOT', 'os-version']])},
  ).body

  assert.match(body, /<version>\{ee-version\}<\/version>/,
    'the block template wins: the fence carries the name the SOURCE wrote')
  assert.doesNotMatch(body, /\{os-version\}/,
    'and the value map does not get a second bite at a line a template already named')
  assert.match(body, /^```xml vars$/m, 'the fence is flagged `vars` so CodeBlock resolves the placeholder')
  ok('fences: block templates beat line templates beat the value map, and each line is claimed once')
}

// A fence FLAG needs a language in front of it. MDX reads the first token of the
// info string as the language, so a flag on a language-less fence becomes the
// language and the metastring comes out empty — the swizzled CodeBlock then never
// sees `vars`/`conums` and the placeholders reach the reader as literal braces
// (hazelcast clients/cplusplus, caught by fidelity Layer 1 as added code text).
{
  const fence = (code, lang) =>
    `<div class="listingblock"><div class="content"><pre class="highlight">` +
    (lang ? `<code class="language-${lang}">` : '<code>') + code + '</code></pre></div></div>'
  const lines = new Map([['hazelcast-cpp-client/5.7.0', 'hazelcast-cpp-client/{page-latest-supported-cplusplus-client}']])
  const st = {pageUrl: '/x', codeVars: {blocks: new Map(), lines}, codeValueVars: new Map()}

  const noLang = convertBody(fence('hazelcast-cpp-client/5.7.0', null), st).body
  assert.match(noLang, /^```text vars$/m,
    'a language-less fence carrying a flag gets the explicit no-highlighting language')

  const withLang = convertBody(fence('hazelcast-cpp-client/5.7.0', 'shell'), st).body
  assert.match(withLang, /^```shell vars$/m, "a fence with a language keeps its own")

  // No flag, no language -> nothing added: the fence stays exactly as it was.
  const plain = convertBody(fence('just text', null), {pageUrl: '/x'}).body
  assert.match(plain, /^```$/m, 'a plain fence gains no language it did not have')
  ok('fence info strings: a flag never gets read as the language')
}

console.log(`\n[converter selftest] ${n} groups passed.`)
