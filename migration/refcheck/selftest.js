'use strict'

// Unit self-test for the reference checker's pure logic: the poison instrumen-
// tation, the census scanner that reads expectations off the poisoned render, the
// disposition table, and the MDX-side reference counter. Each group asserts the
// SPEC (what the gate promises) against hand-written inputs, not the shape of the
// implementation. Run:
//   node refcheck/selftest.js

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  poisonAttributes, poisonComponentVersions, poisonedValueFor, unmask, residualTokens, tokenFor,
} = require('../antora-extension/poison-attributes')
const { isReserved } = require('../lib/reserved-attrs')
const { scanCensusPage, maskDerivedIds, unmaskGuard, hiddenBranchComponents } = require('./lib/census-ledger')
const { dispositionForText, dispositionForAttr, isPreserve } = require('./lib/bake-contexts')
const {
  refCounts, countMdxRefs, countExampleRefs, usageCount, dropLiteralFences, dropHiddenBranches,
  importsOf, slugOf, stripFrontmatter, frontmatterTokens,
} = require('./lib/mdx-refs')
const { includesIn, resolveTarget, sliceByTags, stripComments } = require('./lib/source-refs')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- poisoning: what gets a token, and what must not --------------------------
{
  const attrs = {
    'hazelcast-cloud': 'Cloud',
    'page-cloud-console': 'https://cloud.hazelcast.com/',
    'full-version': '5.6.0',
    'source-highlighter': 'highlight.js', // reserved: machinery
    'page-some-switch': true,             // flag, not text
    'page-some-empty': '',                // renders nothing
  }
  let seq = 0
  const { entries, skipped } = poisonAttributes(attrs, () => ++seq)
  const names = entries.map((e) => e.name).sort()
  assert.deepStrictEqual(names, ['full-version', 'hazelcast-cloud', 'page-cloud-console'],
    'only content attributes are poisoned')
  assert.deepStrictEqual(skipped.map((s) => `${s.name}:${s.reason}`).sort(),
    ['page-some-empty:empty', 'page-some-switch:flag', 'source-highlighter:reserved'],
    'machinery, flags and empty values are left at their real values, with the reason recorded')
  assert.strictEqual(attrs['source-highlighter'], 'highlight.js', 'a reserved value is untouched IN PLACE')
  assert.notStrictEqual(attrs['hazelcast-cloud'], 'Cloud', 'a content value is replaced IN PLACE')
  assert.strictEqual(new Set(entries.map((e) => e.token)).size, entries.length, 'tokens are unique')
  ok('poisonAttributes: poisons content only; records why each skip was skipped')
}

// --- poisoning: component versions that share one table -----------------------
// Antora hands a component version with no `asciidoc` of its own the SITE config
// by reference. Each version must still come out with its own token whose
// recorded value is the REAL value, and the site table must stay unpoisoned.
{
  const site = { attributes: { 'hazelcast-cloud': 'Cloud' } }
  const components = [
    { name: 'home', versions: [{ version: '', asciidoc: site }] },
    { name: 'tutorials', versions: [{ version: '', asciidoc: site }] },
    { name: 'imdg', versions: [{ version: '4.2', asciidoc: site }] },
  ]
  let seq = 0
  const { entries } = poisonComponentVersions(components, (c) => c !== 'imdg', () => ++seq)
  assert.deepStrictEqual(entries.map((e) => `${e.component}:${e.value}`), ['home:Cloud', 'tutorials:Cloud'],
    'every sharer records the real value, not a previous sharer\'s token')
  const [home, tutorials] = entries
  assert.notStrictEqual(home.token, tutorials.token, 'each sharer gets its own token')
  assert.strictEqual(components[0].versions[0].asciidoc.attributes['hazelcast-cloud'], home.rendered,
    'home renders its own token')
  assert.strictEqual(components[1].versions[0].asciidoc.attributes['hazelcast-cloud'], tutorials.rendered,
    'tutorials renders its own token')
  assert.strictEqual(site.attributes['hazelcast-cloud'], 'Cloud', 'the shared site table is not poisoned')
  assert.strictEqual(components[2].versions[0].asciidoc.attributes['hazelcast-cloud'], 'Cloud',
    'an out-of-scope component is not poisoned')
  ok('poisonComponentVersions: a shared table is poisoned once per version, never cumulatively')
}

// --- poisoning: shape preservation -------------------------------------------
// Attribute substitution runs BEFORE the macro pass, so `{url}[text]` only becomes
// a link because the value looks like a URL. A bare token there would change the
// rendered structure and move the very content the census is trying to locate.
{
  const t = tokenFor(7)
  assert.match(poisonedValueFor('https://cloud.hazelcast.com/', t), /^https:\/\/.*\/$/,
    'a URL value poisons to a URL, keeping its trailing slash')
  assert.match(poisonedValueFor('http://x.example/a/b', t), /^http:\/\//,
    'the scheme is preserved so autolinking still fires')
  assert.strictEqual(poisonedValueFor('https://x.example/a/b', t).endsWith('/'), false,
    'no trailing slash is invented where the real value had none')
  assert.match(poisonedValueFor('www.example.com', t), /^www\./, 'a www. value stays autolinkable')
  assert.strictEqual(poisonedValueFor('5.6.0', t), t, 'a plain value poisons to the bare token')
  assert.strictEqual(poisonedValueFor('true@', t), t + '@', 'an Antora soft-set marker survives')
  ok('poisonedValueFor: same lexical shape, unique content')
}

// --- poisoning: reversibility (what makes the census believable) --------------
{
  const entries = [
    { name: 'a', token: tokenFor(1), value: 'Cloud', rendered: tokenFor(1), unmaskSafe: true },
    { name: 'b', token: tokenFor(2), value: 'https://real/', rendered: `https://${tokenFor(2)}.invalid/`, unmaskSafe: true },
  ]
  const rendered = `<p>${tokenFor(1)} at <a href="https://${tokenFor(2)}.invalid/x">${tokenFor(1)}</a></p>`
  const back = unmask(rendered, entries)
  assert.strictEqual(back, '<p>Cloud at <a href="https://real/x">Cloud</a></p>',
    'every occurrence is restored, including a value with a path appended to it')
  assert.deepStrictEqual(residualTokens(back), [], 'no token survives a complete unmask')
  assert.deepStrictEqual(residualTokens(`stray ${tokenFor(9)}`), [tokenFor(9)],
    'a token that could not be restored is reported, never ignored')
  ok('unmask: restores real values exactly; residual tokens are surfaced')
}

// --- the census guard's one permitted difference ------------------------------
// A token in a heading also changes the slugged anchor id, which a case-sensitive
// unmask cannot restore. That -- and nothing else -- is masked before comparing.
{
  const a = '<h2 id="logs-for-hzref0008x"><a class="anchor" href="#logs-for-hzref0008x"></a>Logs for Cloud</h2>'
  const b = '<h2 id="logs-for-cloud"><a class="anchor" href="#logs-for-cloud"></a>Logs for Cloud</h2>'
  assert.strictEqual(maskDerivedIds(a), maskDerivedIds(b), 'derived ids and their fragments are masked')
  assert.notStrictEqual(maskDerivedIds('<p>Cloud</p>'), maskDerivedIds('<p>Confluent Cloud</p>'),
    'a difference in CONTENT still fails the guard')
  // A tab's id is derived from its LABEL, and the pane that shows it names that id
  // in `aria-labelledby` -- so an attribute in a tab label lands in a derived id
  // AND in a reference to one. hazelcast's `{enterprise-product-name}::` tabsets
  // are exactly this, and masking only `id`/`href#` failed those pages.
  const tabCensus = '<p><a id="tabset1_hzref0052x"></a>Enterprise Edition</p>' +
    '<div class="tab-pane" aria-labelledby="tabset1_hzref0052x">x</div>'
  const tabGolden = '<p><a id="tabset1_enterprise-edition"></a>Enterprise Edition</p>' +
    '<div class="tab-pane" aria-labelledby="tabset1_enterprise-edition">x</div>'
  assert.strictEqual(maskDerivedIds(tabCensus), maskDerivedIds(tabGolden),
    "a tab pane's aria-labelledby is a reference to a derived id, so it is masked too")
  assert.notStrictEqual(
    maskDerivedIds('<div class="tab-pane" aria-labelledby="a">Enterprise</div>'),
    maskDerivedIds('<div class="tab-pane" aria-labelledby="a">Enterprise Edition</div>'),
    "masking the wiring must not forgive a difference in the pane's content")
  ok('maskDerivedIds: forgives derived anchor ids and references to them, never content')
}

// Every position an attribute can reach must carry a disposition: deny-by-default
// is what stops a new rendering context becoming an unchecked hole, so the two
// positions a TAB LABEL reaches -- the derived id and the pane's reference to it --
// must both be classified, and neither may read as 'preserve' (our <Tabs> emits no
// such ids, so there is nothing to preserve them in).
{
  for (const attr of ['id', 'aria-labelledby']) {
    const d = dispositionForAttr(attr)
    assert(d, `${attr} must have a disposition, not fall through to deny-by-default`)
    assert(!isPreserve(d), `${attr} is a derived id, so it must bake, not preserve`)
    assert.match(d, /^bake:/, `${attr}'s disposition must record a reason`)
  }
  assert.strictEqual(dispositionForAttr('onclick'), null,
    'an unrecognised position must stay unclassified so the gate fails on it')
  ok('bake-contexts: a tab label\'s id and its pane reference are classified as derived ids')
}

// --- positions the converter replaces WHOLESALE --------------------------------
// A badge and a tab label are not places a reference can live: the converter emits
// `<Badge type="enterprise"/>` and `<TabItem label="…">`, a self-closing component
// and a plain string prop, neither with a slot for a `{name}`. They must therefore
// be classified as bakes -- and, critically, they must WIN over the container they
// sit in, because the converter replaces them regardless of nesting. A badge inside
// a table cell's `<code>` is still a badge (hazelcast integrate/connectors has
// three), and reading it as `code` made the gate demand a reference that cannot
// exist there.
{
  for (const context of ['badge', 'tab-label']) {
    const d = dispositionForText(context)
    assert(d, `${context} must have a disposition, not fall through to deny-by-default`)
    assert(!isPreserve(d), `${context} has no slot for a reference, so it must bake`)
    assert.match(d, /^bake:/, `${context}'s disposition must record a reason`)
  }
  // The ordinary flow contexts still preserve: exempting the badge must not exempt
  // a prose occurrence of the same attribute on the same page.
  for (const context of ['text', 'heading', 'code']) {
    assert(isPreserve(dispositionForText(context)),
      `${context} must still preserve -- that is the whole point of keying on position`)
  }
  assert.strictEqual(dispositionForText('aside'), null,
    'an unrecognised text context must stay unclassified so the gate fails on it')
  ok('bake-contexts: a badge and a tab label bake; prose, headings and code still preserve')
}

// The census walker's classification, against the shapes Asciidoctor really emits.
// Precedence is the substance here: `what the text IS` beats `where it sits`.
{
  const tokens = [{ name: 'enterprise-product-name', token: tokenFor(1), value: 'Enterprise Edition', rendered: tokenFor(1), unmaskSafe: true }]
  const scan = (html) => scanCensusPage(html, { tokens })

  // Prose: preserved, so it is expected in the MDX.
  assert.strictEqual(scan(`<p>Hazelcast ${tokenFor(1)} is licensed.</p>`).preserve.get('enterprise-product-name'), 1,
    'a prose occurrence is a reference the MDX must carry')

  // A badge, bare and nested in <code> inside a table cell -- the connectors shape.
  for (const html of [
    `<p><strong class="enterprise">${tokenFor(1)}</strong></p>`,
    `<td class="tableblock"><p class="tableblock"><code><a href="/x">y</a>\n<strong class="enterprise">${tokenFor(1)}</strong></code></p></td>`,
  ]) {
    const r = scan(html)
    assert.strictEqual(r.preserve.size, 0, 'a badge label is never expected as a reference')
    assert.deepStrictEqual(r.bakes.map((b) => b.disposition), ['bake:badge-label'],
      'a badge is recorded as a badge wherever it sits -- <code> must not reclassify it')
    assert.deepStrictEqual(r.unknown, [], 'and it is classified, not left to fail the gate')
  }

  // A tab TITLE list, and the pane content beside it. The label bakes; anything in
  // the pane is ordinary content and still preserves.
  const tabset =
    `<div class="tabset is-loading"><div class="ulist tabs"><ul><li><p>` +
    `<a id="tabset1_${tokenFor(1).toLowerCase()}"></a>${tokenFor(1)}</p></li></ul></div>` +
    `<div class="content"><div class="tab-pane" aria-labelledby="tabset1_${tokenFor(1).toLowerCase()}">` +
    `<div class="paragraph"><p>Only in ${tokenFor(1)}.</p></div></div></div></div>`
  const t = scan(tabset)
  assert.strictEqual(t.preserve.get('enterprise-product-name'), 1,
    "the PANE's prose is still a reference -- only the label bakes")
  assert.deepStrictEqual(t.bakes.map((b) => b.disposition).sort(),
    ['bake:anchor-id', 'bake:anchor-id', 'bake:tab-label'],
    'one source occurrence, three baked positions: the label, its derived id, and the pane reference')
  assert.deepStrictEqual(t.unknown, [], 'no position in a tabset is left unclassified')
  ok('census walker: badge and tab-label beat their container; pane content and prose are unaffected')
}

// --- which conditional branch did this version render? ------------------------
// A version whose render had `snapshot` set shows the then-branch, so the
// else-branch is the one to skip; a release render the reverse.
{
  assert.deepStrictEqual(hiddenBranchComponents(true), ['IfNotSnapshot'],
    'a snapshot render kept the then-branch, so the else-branch is the hidden one')
  assert.deepStrictEqual(hiddenBranchComponents(false), ['IfSnapshot'],
    'a release render kept the else-branch, so the then-branch is hidden')
  ok('hiddenBranchComponents: the version\'s snapshot state names the half it hides')
}

// --- MDX side: only the branch this version renders is counted ----------------
// The converter puts BOTH halves in every version's MDX so a `docs:version` cut
// carries both. Counting the hidden half would be a surplus the census can never
// account for -- which is exactly how management-center's install.adoc read as
// OVER-variableised (expected 4, found 6) when both halves reference {full-version}.
{
  const body = [
    'Outside: {full-version} and {full-version}.',
    '',
    '   <IfSnapshot>',
    '   Snapshot half, no reference.',
    '   </IfSnapshot>',
    '',
    '   <IfNotSnapshot>',
    '   Release half: {full-version}.',
    '   </IfNotSnapshot>',
  ].join('\n')
  assert.strictEqual(countMdxRefs(dropHiddenBranches(body, ['IfNotSnapshot']), 'full-version'), 2,
    'a snapshot version counts its own half only')
  assert.strictEqual(countMdxRefs(dropHiddenBranches(body, ['IfSnapshot']), 'full-version'), 3,
    'a release version counts the else-branch it renders')
  assert.strictEqual(countMdxRefs(dropHiddenBranches(body, []), 'full-version'), 3,
    'no hidden branch named: nothing is dropped')
  assert.strictEqual(dropHiddenBranches('   <IfSnapshot>\ntail {full-version}', ['IfSnapshot']),
    '   <IfSnapshot>\ntail {full-version}',
    'an unterminated wrapper is left alone rather than swallowing the rest of the page')

  // Through the whole closure, on the file layout the converter emits: an indented
  // wrapper inside a <TabItem>, plus a partial carrying the same shape.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refcheck-branches-'))
  const site = path.join(dir, 'site')
  fs.mkdirSync(path.join(site, 'mc', '_partials'), { recursive: true })
  fs.writeFileSync(path.join(site, 'mc', '_partials', 'p.mdx'),
    ['<IfSnapshot>', '<Variable name="full-version"/>', '</IfSnapshot>', '<IfNotSnapshot>',
      '<Variable name="full-version"/>', '</IfNotSnapshot>'].join('\n') + '\n')
  const pageFile = path.join(site, 'mc', 'install.mdx')
  fs.writeFileSync(pageFile, [
    "import PartialP from '@site/mc/_partials/p.mdx';",
    '',
    body,
    '<PartialP/>',
  ].join('\n'))
  assert.strictEqual(refCounts(pageFile, site, ['full-version'], { hiddenBranches: ['IfNotSnapshot'] })
    .get('full-version'), 3, 'the hidden half is dropped in the page AND in its partials (2 + 1)')
  assert.strictEqual(refCounts(pageFile, site, ['full-version']).get('full-version'), 5,
    'with no hidden branch named, both halves count -- the surplus the census cannot explain')
  fs.rmSync(dir, { recursive: true, force: true })
  ok('refCounts: a spliced page is counted in the half this version renders, not both')
}

// --- the disposition table is closed and deny-by-default ---------------------
{
  assert(isPreserve(dispositionForText('text')), 'prose must keep its reference')
  assert(isPreserve(dispositionForText('heading')), 'a heading can hold a <Variable>')
  assert(isPreserve(dispositionForText('code')), 'a `vars` fence resolves its tokens')
  assert(isPreserve(dispositionForAttr('href')), 'a link destination can be a link-mode <Variable>')
  assert(!isPreserve(dispositionForAttr('alt')), 'Markdown image alt text cannot hold a component')
  assert(!isPreserve(dispositionForAttr('id')), 'an anchor id must stay a literal to preserve the URL fragment')
  assert.strictEqual(dispositionForAttr('data-whatever'), null,
    'an unrecognised position has NO disposition, so the gate fails rather than guessing')
  assert.strictEqual(dispositionForText('nowhere'), null, 'same for an unrecognised text context')
  ok('bake-contexts: preserve/bake per POSITION; unknown positions fail closed')
}

// --- the census scanner ------------------------------------------------------
{
  const tokens = [
    { name: 'hazelcast-cloud', token: tokenFor(1), value: 'Cloud', rendered: tokenFor(1), unmaskSafe: true },
    { name: 'page-cloud-console', token: tokenFor(2), value: 'https://real/', rendered: `https://${tokenFor(2)}.invalid/`, unmaskSafe: true },
  ]
  const html = [
    `<p>${tokenFor(1)} is one, ${tokenFor(1)} is two.</p>`,
    `<h2 id="a-${tokenFor(1)}-h"><a class="anchor" href="#a-${tokenFor(1)}-h"></a>${tokenFor(1)} heading</h2>`,
    `<a href="https://${tokenFor(2)}.invalid/">console</a>`,
    `<div class="imageblock"><img src="x.png" alt="${tokenFor(1)} diagram"></div>`,
    `<pre class="highlight"><code>helm install ${tokenFor(1)}</code></pre>`,
  ].join('\n')
  const { preserve, bakes, unknown } = scanCensusPage(html, { tokens })

  assert.deepStrictEqual(unknown, [], 'every position in ordinary Antora output is classified')
  // 2 prose + 1 heading text + 1 code = 4 preserved; the id (x2: id + fragment)
  // and the alt text are recorded bakes.
  assert.strictEqual(preserve.get('hazelcast-cloud'), 4,
    'counts EVERY preserved occurrence, not just whether the name appears')
  assert.strictEqual(preserve.get('page-cloud-console'), 1, 'an href occurrence is preserved')
  const reasons = bakes.filter((b) => b.name === 'hazelcast-cloud').map((b) => b.disposition).sort()
  assert.deepStrictEqual(reasons, ['bake:anchor-id', 'bake:anchor-id', 'bake:image-alt'],
    'the id, its fragment and the alt text are recorded as bakes, not counted as expectations')
  ok('scanCensusPage: per-occurrence expectations, with unpreservable positions recorded separately')

  // The property the whole approach buys: a literal that merely EQUALS a real
  // value carries no token, so it cannot become an expectation.
  const literal = scanCensusPage('<p>Cloud is a word. 5.7.0 is a version.</p>', { tokens })
  assert.strictEqual(literal.preserve.size, 0, 'a coincidental literal is never expected to be a reference')
  ok('scanCensusPage: coincidental literals cannot produce expectations')
}

// --- MDX side: every preserved form counts, once each ------------------------
{
  assert.strictEqual(countMdxRefs('a <Variable name="ucn"/> b <Variable name="ucn"/>', 'ucn'), 2,
    'each prose <Variable> counts')
  assert.strictEqual(countMdxRefs('<Variable href="{page-cloud-console}" text="{ucn} console"/>', 'ucn'), 1,
    'a {name} token in a link-mode <Variable> counts once')
  assert.strictEqual(countMdxRefs('the word Cloud, baked', 'hazelcast-cloud'), 0,
    'a baked literal is not a reference')
  assert.strictEqual(countMdxRefs('escaped \\{ucn} stays literal', 'ucn'), 0, 'an escaped token is not a reference')
  assert.strictEqual(countExampleRefs('image: hazelcast:{full-version}\n', 'full-version'), 1,
    'a placeholder in an example file is a reference (the loader substitutes it at build)')
  ok('countMdxRefs/countExampleRefs: count every preserved form, reject baked and escaped literals')
}

// --- MDX side: an xref VERSION COORDINATE is not countable --------------------
// The census cannot see a coordinate (preResolveTargets substitutes the real value
// into xref targets before poisoning, or the render breaks), so it never enters
// `expected` — and counting it here would make `actual` exceed `expected` on any
// page that also has a genuine reference to the same attribute.
//
// The oracle is the gate's own invariant rather than the shape of the regex: on a
// page carrying one coordinate and one real reference, actual must equal the ONE
// occurrence the census can see. Both of the converter's outcomes for a coordinate
// are exercised, because the gate must balance without knowing which it chose.
{
  const attr = 'page-latest-supported-hazelcast'
  const real = '<Variable href="https://github.com/hazelcast/hazelcast/tree/v{page-latest-supported-hazelcast}.0/x.xml" text="XML"/>'
  const coord = '<Variable href="/hazelcast/{page-latest-supported-hazelcast}/sql/create-index" text="CREATE INDEX"/>'
  const floated = '[CREATE INDEX](/hazelcast/latest/sql/create-index)'

  assert.strictEqual(countMdxRefs(coord, attr), 0, 'a coordinate alone counts as nothing')
  assert.strictEqual(countMdxRefs(floated, attr), 0, 'a coordinate floated to /latest/ leaves nothing to count')
  assert.strictEqual(countMdxRefs(real, attr), 1, 'a reference inside an external URL still counts')
  // The page that produced the false finding: same census expectation (1) either
  // way, so the gate balances whichever form the converter emitted.
  assert.strictEqual(countMdxRefs(`${coord}\n${real}`, attr), 1,
    'coordinate + real reference == the one occurrence the census can see')
  assert.strictEqual(countMdxRefs(`${floated}\n${real}`, attr), 1,
    'floated coordinate + real reference == the same count')

  // The exclusion is narrow: only the version SEGMENT of a site-absolute path. An
  // external URL that happens to contain the same attribute mid-path is a real
  // reference (cloud's release-notes link) and must survive.
  const external = '<Variable href="https://docs.hazelcast.com/hazelcast/{page-cloud-platform-version}/release-notes/releases" text="notes"/>'
  assert.strictEqual(countMdxRefs(external, 'page-cloud-platform-version'), 1,
    'a scheme-bearing URL is not a coordinate, however similar the path looks')
  assert.strictEqual(countMdxRefs('<Variable name="page-latest-supported-hazelcast"/>', attr), 1,
    'a prose <Variable> for the same attribute is untouched by the exclusion')
  ok('countMdxRefs: an xref version coordinate is excluded, matching what the census can see')
}

// --- MDX side: a plain fence is literal, a `vars` fence is not ---------------
{
  const mdx = ['```yaml', 'name: {ucn}', '```', '', '```shell vars', 'install {ucn}', '```'].join('\n')
  const body = dropLiteralFences(mdx)
  assert.strictEqual(countMdxRefs(body, 'ucn'), 1,
    'only the `vars` fence contributes: Docusaurus renders a plain fence literally')
  ok('dropLiteralFences: {name} in a non-vars fence is a literal, not a reference')
}

// --- MDX side: frontmatter is inert, not a reference -------------------------
// Docusaurus does not interpolate YAML frontmatter, so a token there reaches the
// reader as literal braces. Counting it as a reference would BOTH hide that bug
// and mask a genuine bake elsewhere on the page.
{
  const mdx = '---\ntitle: "X"\nsidebar_label: "Connect to {hazelcast-cloud}"\n---\n\nProse <Variable name="hazelcast-cloud"/>.\n'
  assert.strictEqual(countMdxRefs(stripFrontmatter(mdx), 'hazelcast-cloud'), 1,
    'only the body reference counts')
  assert.strictEqual(frontmatterTokens(mdx, ['hazelcast-cloud']).get('hazelcast-cloud'), 1,
    'the frontmatter token is reported separately')
  assert.strictEqual(frontmatterTokens('no frontmatter {hazelcast-cloud}', ['hazelcast-cloud']).size, 0,
    'a body token is not mistaken for frontmatter')
  ok('stripFrontmatter/frontmatterTokens: frontmatter tokens are a finding, never a reference')
}

// --- MDX side: multiplicity -------------------------------------------------
// The golden inlines a partial at every include site, so the converted page must
// be credited once per USE of the imported component -- otherwise a partial used
// twice looks like a baked reference.
{
  assert.strictEqual(usageCount('<PartialA/>\ntext\n<PartialA />', 'PartialA', 'partial'), 2, 'counts component uses')
  assert.strictEqual(usageCount('<PartialAB/>', 'PartialA', 'partial'), 0, 'does not match a longer component name')
  assert.strictEqual(usageCount('<CodeBlock>{Ex_x}</CodeBlock>', 'Ex_x', 'example'), 1, 'counts example expression uses')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refcheck-selftest-'))
  const site = path.join(dir, 'site')
  fs.mkdirSync(path.join(site, 'cloud', '_partials'), { recursive: true })
  fs.mkdirSync(path.join(site, 'cloud', 'examples'), { recursive: true })
  fs.writeFileSync(path.join(site, 'cloud', '_partials', 'p.mdx'), 'Shared <Variable name="ucn"/>.\n')
  fs.writeFileSync(path.join(site, 'cloud', 'examples', 'e.yaml'), 'v: {full-version}\n')
  const page = path.join(site, 'cloud', 'page.mdx')
  fs.writeFileSync(page, [
    "import PartialP from '@site/cloud/_partials/p.mdx';",
    "import Ex_e from './examples/e.yaml';",
    '',
    'Own <Variable name="ucn"/>.',
    '<PartialP/>',
    '<PartialP/>',
    '<CodeBlock>{Ex_e}</CodeBlock>',
  ].join('\n'))

  const counts = refCounts(page, site, ['ucn', 'full-version'])
  assert.strictEqual(counts.get('ucn'), 3, 'own reference + the partial counted once per use (1 + 2)')
  assert.strictEqual(counts.get('full-version'), 1, 'an imported example contributes its placeholders')
  fs.rmSync(dir, { recursive: true, force: true })
  ok('refCounts: page + partials (per use) + examples, so multiplicity cannot look like baking')
}

// --- MDX side: import + slug parsing ----------------------------------------
{
  const mdx = [
    "import PartialClusterData from '@site/cloud/_partials/cluster-data.mdx'",
    "import Ex_hazelcast_yaml from '../examples/hazelcast.yaml';",
    "import Ex_cp_tag_apisample from '../examples/cp/CpSubsystemAPI.java?tag=apisample&indent=0';",
    "import CodeBlock from '@theme/CodeBlock';",
    'import PartialDq from "@site/cloud/_partials/dq.mdx";',
  ].join('\n')
  const { partials, examples } = importsOf(mdx, '/root/cloud/manage/x.mdx', '/root')
  assert.deepStrictEqual(partials, [
    { id: 'PartialClusterData', file: '/root/cloud/_partials/cluster-data.mdx' },
    { id: 'PartialDq', file: '/root/cloud/_partials/dq.mdx' },
  ], 'resolves @site partial imports in either quote style and keeps their identifiers')
  assert.deepStrictEqual(examples[0], { id: 'Ex_hazelcast_yaml', query: '', file: '/root/cloud/examples/hazelcast.yaml' },
    'resolves a relative example import and keeps its identifier')
  // A region selector must not end up glued to the path, or the file cannot be
  // read at all -- and what the page shows is the SLICE, so the query has to
  // survive as its own field for the accounting to slice the same way the build
  // does.
  assert.deepStrictEqual(examples[1], {
    id: 'Ex_cp_tag_apisample',
    query: '?tag=apisample&indent=0',
    file: '/root/cloud/examples/cp/CpSubsystemAPI.java',
  }, 'splits a region selector off the resolved path, keeping both')
  assert.strictEqual(slugOf('---\ntitle: "X"\nslug: /cloud/foo\n---\nbody'), '/cloud/foo', 'reads the URL-preserving slug')
  ok('importsOf/slugOf: identifiers and paths for the closure; the slug joins page to manifest')
}

// --- reserved attributes ----------------------------------------------------
{
  assert(isReserved('source-highlighter') && isReserved('idprefix'), 'rendering machinery is reserved')
  assert(!isReserved('hazelcast-cloud') && !isReserved('full-version'), 'content attributes are not')
  ok('reserved-attrs: machinery only, so content is always poisoned and therefore always checked')
}

// --- source-side include walker (examples only) -----------------------------
{
  const incs = includesIn('include::partial$note.adoc[]\ninclude::example$/x.yaml[tag=demo]\nnot an include')
  assert.strictEqual(incs.length, 2, 'finds both includes')
  assert.strictEqual(incs[1].tag, 'demo', 'captures tag=')

  const from = { component: 'operator', module: 'ROOT', family: 'page', relative: 'upgrade.adoc' }
  assert.strictEqual(resolveTarget('example$/x.yaml', from).family, 'example', 'example$ family')
  assert.strictEqual(resolveTarget('partial$note.adoc', from).family, 'partial', 'partial$ is walked through')
  assert.strictEqual(resolveTarget('imdg:ROOT:partial$x.adoc', from), null, 'no-mirror component -> null')

  const doc = 'pre\n// tag::demo[]\ninclude::example$in.yaml[]\n// end::demo[]\ninclude::example$out.yaml[]'
  assert(sliceByTags(doc, 'demo').includes('in.yaml'), 'tag slicing keeps the selected region')
  assert(!sliceByTags(doc, 'demo').includes('out.yaml'), 'and drops the rest')
  assert(!stripComments('// include::example$x.yaml[]').includes('include'), 'a commented include is not one')
  ok('source-refs: finds the example$ includes a page reaches, through partials and tag slices')
}

console.log(`\n[refcheck selftest] ${n} groups passed.`)
