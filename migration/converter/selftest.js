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
const { convertBody } = require('./lib/html-to-mdx')
const { classifyHref } = require('../fidelity/lib/links')
const { collectOccurrences, decide, slugFor, componentNameFor, parseId, consumerAttrs } = require('./lib/partials')
const { normalizeValues, groupIdFor } = require('./lib/tabs')
const { parseNav, buildPlan, injectNavEntries, parseTarget, pageKey, folderName } = require('./lib/nav')
const { wrapRefs, wrappableRefs } = require('../antora-extension/mark-attributes')
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

  // A macro target sits on a flow line, so it stays eligible: cloud's
  // page-cloud-platform-version is referenced only inside a `link:` URL, and
  // treating it as prose is what preserves the existing link-mode behaviour.
  const macro = 'link:https://docs.hazelcast.com/hazelcast/{page-cloud-platform-version}/x[Platform] in use.'
  assert.ok(wrappableRefs(macro, ['page-cloud-platform-version']).has('page-cloud-platform-version'),
    'a reference inside a link macro target counts as prose-eligible (conservative: keeps link behaviour)')
  ok('prose-eligibility: verbatim-only references are excluded, flow text and macro targets are not')
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
  assert.throws(() => groupIdFor(['java']), /matches families/,
    'a signature matching two families must be rejected, not silently assigned to one')
  ok('tabs: an ambiguous alias or family match is a hard error, never a silent choice')
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

console.log(`\n[converter selftest] ${n} groups passed.`)
