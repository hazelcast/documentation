'use strict'

// Unit self-test for the converter's pure text primitives:
//   1. mdx.js  -- the MDX-safety escapers. A bug here silently CORRUPTS output
//      (a stray `*` becomes emphasis, a `<` opens a tag) on rare characters the
//      fidelity harness may not exercise, so the edge cases are pinned here.
//   2. the link classifiers -- converter/lib/links.js (emits the href) and
//      fidelity/lib/links.js (checks it) MUST agree on external/anchor/internal
//      and on the resolved path, or a link the converter emits fails its own
//      Layer-3 check. The comment in links.js promises this; this test enforces it.
//
// All pure. Run: node converter/selftest.js

const assert = require('node:assert')

const { mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode } = require('./lib/mdx')
const { resolveHref } = require('./lib/links')
const { classifyHref } = require('../fidelity/lib/links')
const { collectOccurrences, decide, slugFor, componentNameFor, parseId } = require('./lib/partials')
const { parseNav, buildPlan, targetStem, folderName } = require('./lib/nav')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- mdEscape: liberal, fidelity-safe backslash escaping ---------------------
{
  assert.strictEqual(mdEscape('a*b_c'), 'a\\*b\\_c', 'emphasis chars escaped')
  assert.strictEqual(mdEscape('x[y]z'), 'x\\[y\\]z', 'link brackets escaped')
  assert.strictEqual(mdEscape('a<b>c'), 'a\\<b\\>c', 'angle brackets escaped in prose')
  assert.strictEqual(mdEscape('use {x} and #h'), 'use \\{x\\} and \\#h', 'braces and hash escaped')
  assert.strictEqual(mdEscape('a\\b'), 'a\\\\b', 'a literal backslash is escaped (once, not doubled)')
  // Typographic folding still happens, and folded quotes are NOT escaped.
  assert.strictEqual(mdEscape('“q” a b'), '"q" a b', 'curly quotes folded, nbsp folded, quote not escaped')
  ok('mdEscape: escapes MD-active punctuation, folds typography, no double-escape')

  assert.strictEqual(mdEscapeCell, mdEscape, 'mdEscapeCell is mdEscape (pipe already in the set)')
  assert.strictEqual(mdEscapeCell('a|b'), 'a\\|b', 'pipe escaped for GFM cells')
  ok('mdEscapeCell: escapes the table pipe')
}

// --- jsxText / jsxAttr: entity-encode the JSX-hostile characters -------------
{
  assert.strictEqual(jsxText('a<b>{c}&d'), 'a&lt;b&gt;&#123;c&#125;&amp;d', 'all five JSX-hostile chars entified')
  assert.strictEqual(jsxText('A & B'), 'A &amp; B', 'ampersand encoded first (not double-encoded)')
  ok('jsxText: <, >, {, }, & become entities')

  assert.strictEqual(jsxAttr('plain'), '"plain"', 'wraps in double quotes')
  assert.strictEqual(jsxAttr('say "hi" & bye'), '"say &quot;hi&quot; &amp; bye"', 'quotes and & escaped inside')
  ok('jsxAttr: double-quoted literal with escaped " and &')
}

// --- inlineCode / fencedCode: fence longer than any inner run ----------------
{
  assert.strictEqual(inlineCode('a'), '`a`', 'simple inline code')
  assert.strictEqual(inlineCode('a`b'), '``a`b``', 'fence grows past an inner backtick')
  assert.strictEqual(inlineCode('`x`'), '`` `x` ``', 'pads when content starts/ends with a backtick')
  ok('inlineCode: chooses a non-splitting backtick fence')

  assert.strictEqual(fencedCode('code', 'js'), '```js\ncode\n```', 'default triple fence with language')
  assert.strictEqual(fencedCode('```\nx', ''), '````\n```\nx\n````', 'fence grows past an embedded ``` run')
  ok('fencedCode: fence never terminated early by embedded backticks')
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

  assert.strictEqual(slugFor('cloud:ROOT:partial$create-api-key.adoc'), 'create-api-key', 'ROOT module -> no prefix')
  assert.strictEqual(slugFor('operator:mymod:partial$deep/path/note.adoc'), 'mymod-deep-path-note',
    'non-ROOT module prefixed, path separators flattened')
  assert.strictEqual(componentNameFor('create-api-key'), 'PartialCreateApiKey', 'PascalCase component name')
  ok('slugFor / componentNameFor: stable slug + component identifier')
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

  const leaf = buildPlan(parseNav('.Guide\n* xref:install.adoc[Install]'))
  assert.deepStrictEqual(leaf.pages.get('install'), {
    relFile: path.join('guide', 'install.mdx'), slug: '/install', sidebarLabel: 'Install', sidebarPosition: 1,
  }, 'leaf page: slug preserves the flat URL, nav label kept')
  assert.deepStrictEqual(leaf.categories[0], {
    relFile: path.join('guide', '_category_.json'), content: { label: 'Guide', position: 1, link: null },
  }, 'category folder gets a non-clickable _category_.json')
  ok('buildPlan: leaf page + category file')

  // sidebar_label is suppressed when the nav label equals the page's doctitle.
  const noLabel = buildPlan(parseNav('.Guide\n* xref:install.adoc[Install]'), new Map([['install', 'Install']]))
  assert.strictEqual(noLabel.pages.get('install').sidebarLabel, null, 'redundant sidebar_label dropped')
  ok('buildPlan: drops sidebar_label that duplicates the title')

  // A parent page (has children) becomes a category folder + an Overview page.
  const parent = buildPlan(parseNav('.Guide\n* xref:intro.adoc[Intro]\n* xref:section.adoc[Section]\n** xref:child.adoc[Child]'))
  assert.deepStrictEqual(parent.pages.get('section'), {
    relFile: path.join('guide', 'section', 'overview.mdx'), slug: '/section', sidebarLabel: 'Overview', sidebarPosition: 0,
  }, 'parent page content moves to overview.mdx under its own folder')
  assert(parent.categories.some((c) => c.relFile === path.join('guide', 'section', '_category_.json')),
    'the parent page gets a category folder')
  ok('buildPlan: a parent page splits into a category + Overview')

  const dup = buildPlan(parseNav('.Guide\n* xref:x.adoc[X]\n* xref:x.adoc[Y]'))
  assert.deepStrictEqual(dup.duplicates, ['x'], 'a stem appearing twice is reported as a duplicate')
  ok('buildPlan: reports duplicate stems')
}

console.log(`\n[converter selftest] ${n} groups passed.`)
