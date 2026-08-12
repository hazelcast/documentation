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

const { mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode } = require('./lib/mdx')
const { resolveHref } = require('./lib/links')
const { classifyHref } = require('../fidelity/lib/links')
const { collectOccurrences, decide, slugFor, componentNameFor, parseId } = require('./lib/partials')
const { parseNav, buildPlan, targetStem, folderName } = require('./lib/nav')

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
  ])
  assert(shared.decisions.has('c:ROOT:partial$p.adoc'), 'identical block-level occurrences on 2 pages -> factored')
  assert.strictEqual(shared.decisions.get('c:ROOT:partial$p.adoc').importStmt,
    "import PartialP from '@site/c/_partials/p.mdx';", 'factored id carries its import statement')

  const varies = decide([
    { url: '/a', occ: [occ('c:ROOT:partial$p.adoc', '<p>one</p>')] },
    { url: '/b', occ: [occ('c:ROOT:partial$p.adoc', '<p>two</p>')] },
  ])
  assert(!varies.decisions.has('c:ROOT:partial$p.adoc'), 'differing inner HTML -> declined')
  assert.strictEqual(varies.report[0].reason, 'content-varies', 'decline reason recorded')

  const notBlock = decide([{ url: '/a', occ: [occ('c:ROOT:partial$p.adoc', '<span>x</span>', false)] }])
  assert.strictEqual(notBlock.report[0].reason, 'non-block-level', 'non-block occurrence -> declined')

  // Two distinct ids that slugify identically (a-b.adoc and a/b.adoc): first wins.
  const collide = decide([
    { url: '/a', occ: [occ('c:ROOT:partial$a-b.adoc', '<p>x</p>')] },
    { url: '/b', occ: [occ('c:ROOT:partial$a/b.adoc', '<p>y</p>')] },
  ])
  assert(collide.decisions.has('c:ROOT:partial$a-b.adoc'), 'first id claims the slug')
  const collided = collide.report.find((r) => r.id === 'c:ROOT:partial$a/b.adoc')
  assert.strictEqual(collided.reason, 'slug-collision', 'second id with the same slug is declined')
  ok('decide: factors identical block-level partials, declines varies/non-block/slug-collision')
}

// --- nav: target stem + folder name ------------------------------------------
{
  assert.strictEqual(targetStem('install.adoc'), 'install', 'plain target')
  assert.strictEqual(targetStem('mymod:dir/page.adoc#frag'), 'page', 'strips module, path, and fragment')
  assert.strictEqual(folderName('Data Structures & Maps'), 'data-structures-maps', 'label -> kebab folder name')
  ok('targetStem / folderName: nav target and label normalisation')
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

  // Correctness property (URL preservation, the migration's actual requirement):
  // whatever the folder layout, EVERY page's slug must reproduce its flat Antora
  // URL, i.e. '/' + stem. The file/category layout below it is a free choice.
  const plan = buildPlan(parseNav([
    '.Guide',
    '* xref:intro.adoc[Intro]',
    '* xref:section.adoc[Section]', // parent page -> Overview
    '** xref:child.adoc[Child]',
  ].join('\n')))
  for (const [stem, page] of plan.pages) assert.strictEqual(page.slug, '/' + stem, `slug preserves the URL for ${stem}`)
  ok('buildPlan: every page slug reproduces its flat Antora URL (URL preservation)')

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

console.log(`\n[converter selftest] ${n} groups passed.`)
