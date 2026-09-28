'use strict'

// Unit self-test for the fidelity harness's own correctness -- the two things
// the harness cannot check for itself:
//
//   1. Layer 1 (lib/layer1.js): the normalize + segment + diff logic that IS the
//      "published content must not change" gate. Its danger is a FALSE NEGATIVE:
//      if canonicalize over-normalizes, a real regression reduces equal and the
//      diff stays silently empty. So we pin both that fidelity-SAFE folds happen
//      AND that genuinely different content still diffs.
//   2. Golden de-instrumentation (mark-partials / mark-conditionals): readGolden
//      strips their sentinels before comparing, so if a stripper removed one byte
//      too many or too few the baseline would drift. We pin strip == byte-exact.
//
// All pure; no golden tree, manifest, or build needed. Run: node fidelity/selftest.js

const assert = require('node:assert')

const {
  canonicalize, diffSegments, normalizeProse, normalizeCode, segKey,
  GOLDEN_STRIP, GOLDEN_TABLE, DOCUSAURUS_STRIP,
} = require('./lib/layer1')
const { stripSentinels, createPartialMarker } = require('../antora-extension/mark-partials')
const { wrapConditionals, markability, stripConditionalSentinels, START, END } = require('../antora-extension/mark-conditionals')
const { literalizeMonospace } = require('../antora-extension/normalize-monospace')
const { lockfileKey } = require('./lockfile-key')
const { buildIndex, variants } = require('./lib/manifest-index')
const { inventory, ASCIIDOC_PROFILE, DOCUSAURUS_PROFILE } = require('./lib/structure')
const { compareInventory, compareTitle } = require('./lib/layer2')
const { extractMain, extractPage } = require('./lib/extract-main')
const { checkPage } = require('./lib/layer3')
const { convertedAnchorLookup } = require('./lib/anchor-index')
const { problemKey, novelProblems } = require('./lib/baseline')
const { urlFromGoldenRel, convertedCandidates } = require('./lib/pairing')
const adoc = require('@asciidoctor/core')()

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }
const texts = (segs) => segs.map((s) => s.text)
const renderAdoc = (src) => adoc.convert(src, { standalone: false }) // real renderer, used as an oracle

// --- normalizeProse: fidelity-safe folds only --------------------------------
{
  assert.strictEqual(normalizeProse('“curly” ‘quotes’'), '"curly" \'quotes\'', 'curly quotes -> ASCII')
  assert.strictEqual(normalizeProse('en–dash em—dash'), 'en-dash em-dash', 'en/em dash -> hyphen')
  assert.strictEqual(normalizeProse('more…'), 'more...', 'ellipsis -> ...')
  assert.strictEqual(normalizeProse('a b'), 'a b', 'nbsp -> space')
  assert.strictEqual(normalizeProse('a​b'), 'ab', 'zero-width chars removed')
  assert.strictEqual(normalizeProse('  spaced   \n  out  '), 'spaced out', 'whitespace collapsed + trimmed')
  ok('normalizeProse: folds typographic glyphs, collapses whitespace')

  // The false-negative guard: distinct content must NOT normalize equal.
  assert.notStrictEqual(normalizeProse('foo bar'), normalizeProse('foobar'), 'a real word change survives')
  assert.notStrictEqual(normalizeProse('enable'), normalizeProse('disable'), 'different words stay different')
  ok('normalizeProse: does NOT erase genuine content differences')
}

// --- normalizeCode: verbatim but trailing/blank cleanup ----------------------
{
  assert.strictEqual(normalizeCode('a  \nb\t\n'), 'a\nb', 'trailing whitespace per line + final newline stripped')
  assert.strictEqual(normalizeCode('x\n\n\n\ny'), 'x\n\ny', '3+ blank lines collapse to one')
  assert.strictEqual(normalizeCode('    indented'), '    indented', 'leading indentation preserved (significant)')
  ok('normalizeCode: trims trailing/blank lines, keeps significant whitespace')
}

// --- canonicalize: prose, code, tables, strip --------------------------------
{
  assert.deepStrictEqual(texts(canonicalize('<p>Hello   world</p>')), ['Hello world'], 'prose whitespace collapsed')

  // The headline fidelity property: an author's intra-paragraph line breaks
  // render as one space in BOTH AsciiDoc and Markdown, so they must not split a
  // paragraph into two segments (which would false-positive the diff).
  assert.deepStrictEqual(texts(canonicalize('<p>line one\nline two</p>')), ['line one line two'],
    'source-wrapped paragraph stays ONE segment')
  ok('canonicalize: collapses prose, keeps a wrapped paragraph whole')

  const code = canonicalize('<pre>const x = 1;</pre>')
  assert.deepStrictEqual(code, [{ kind: 'code', text: 'const x = 1;' }], 'plain <pre> -> one code segment')
  // Docusaurus/Prism emits per-line .token-line spans with no newline text node.
  const prism = canonicalize('<pre><span class="token-line">a</span><span class="token-line">b</span></pre>')
  assert.deepStrictEqual(prism, [{ kind: 'code', text: 'a\nb' }], 'token-line spans rebuild code newlines')
  ok('canonicalize: extracts code verbatim from <pre> and Prism token-lines')

  const table = canonicalize(
    '<table class="tableblock"><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    { stripSelectors: GOLDEN_STRIP, tableSelector: GOLDEN_TABLE })
  assert.deepStrictEqual(texts(table), ['│ a │ b', '│ c │ d'], 'content table -> one segment per row')
  ok('canonicalize: represents a content table row-by-row')

  const stripped = canonicalize('<h2><a class="anchor">¶</a>Title</h2>')
  assert.deepStrictEqual(texts(stripped), ['Title'], 'the Asciidoctor ¶ self-link is stripped, not counted as content')
  ok('canonicalize: strips renderer chrome (heading anchor)')

  // Our code block header bar (language label + buttons) is site chrome the
  // golden has no counterpart for, so a block must canonicalize to exactly what
  // the golden's <pre> does -- with the block TITLE, which Asciidoctor renders
  // too, still compared.
  const withHeader = canonicalize(
    '<div class="theme-code-block">' +
    '<div class="codeBlockTitle_x">config.yaml</div>' +
    '<div class="codeBlockContent_x">' +
    '<div class="codeBlockHeader_x"><span class="codeBlockLanguage_x">YAML</span></div>' +
    '<pre>port: 5701</pre></div></div>',
    { stripSelectors: DOCUSAURUS_STRIP })
  assert.deepStrictEqual(withHeader,
    [{ kind: 'text', text: 'config.yaml' }, { kind: 'code', text: 'port: 5701' }],
    'header bar contributes no segment; title and code still do')
  ok('canonicalize: strips the code block header bar, keeps its title and code')
}

// --- diffSegments: only real changes surface ---------------------------------
{
  const a = [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]
  assert.deepStrictEqual(diffSegments(a, a), [], 'identical -> no ops')

  const add = diffSegments(a, [...a, { kind: 'text', text: 'c' }])
  assert.deepStrictEqual(add, [{ op: '+', kind: 'text', text: 'c' }], 'one appended segment -> one +')

  const del = diffSegments([...a, { kind: 'text', text: 'c' }], a)
  assert.deepStrictEqual(del, [{ op: '-', kind: 'text', text: 'c' }], 'one removed segment -> one -')

  const chg = diffSegments(
    [{ kind: 'text', text: 'x' }, { kind: 'text', text: 'b' }, { kind: 'text', text: 'y' }],
    [{ kind: 'text', text: 'x' }, { kind: 'text', text: 'B' }, { kind: 'text', text: 'y' }])
  assert.deepStrictEqual(chg, [{ op: '-', kind: 'text', text: 'b' }, { op: '+', kind: 'text', text: 'B' }],
    'a changed middle segment -> one - and one + (prefix/suffix trimmed)')
  ok('diffSegments: reports add / remove / change, nothing on equal')

  // segKey distinguishes kind, so identical text as code vs prose is a diff.
  assert.notStrictEqual(segKey({ kind: 'code', text: 'x' }), segKey({ kind: 'text', text: 'x' }), 'kind is part of the key')
  const kindDiff = diffSegments([{ kind: 'code', text: 'x' }], [{ kind: 'text', text: 'x' }])
  assert.strictEqual(kindDiff.length, 2, 'same text but code vs prose still diffs')
  ok('segKey: code and prose with identical text are not equal')
}

// --- golden de-instrumentation: strip is byte-exact --------------------------
{
  const clean = 'before\npartial body\nafter\n'
  const marked =
    'before\n' +
    '<!--hz-partial:start cloud:ROOT:partial$x.adoc-->\n' +
    'partial body\n' +
    '<!--hz-partial:end cloud:ROOT:partial$x.adoc-->\n' +
    'after\n'
  assert.strictEqual(stripSentinels(marked), clean, 'mark-partials: strip reproduces golden byte-for-byte')
  assert.strictEqual(stripSentinels(clean), clean, 'mark-partials: strip is a no-op on un-instrumented HTML')
  ok('mark-partials: sentinel strip is byte-exact and idempotent')

  const cleanIf = '<p>before</p>\n<p>inside</p>\n<p>after</p>\n'
  const markedIf = `<p>before</p>\n${START}\n<p>inside</p>\n${END}\n<p>after</p>\n`
  assert.strictEqual(stripConditionalSentinels(markedIf), cleanIf, 'mark-conditionals: strip reproduces golden byte-for-byte')
  ok('mark-conditionals: rendered-sentinel strip is byte-exact')
}

// --- mark-partials: an include's content lands INSIDE its sentinels ----------
//
// The spec the marker exists to meet: for every include site the page does not
// fuse its own content into, the HTML between that id's sentinels is the whole
// of the included fragment -- nothing of the partial left outside, nothing of
// the page dragged inside. The oracle is independent: render the partial's
// source on its own with Asciidoctor and compare.
//
// This is the gate on Asciidoctor's include attribution, which is NOT uniform:
// the final paragraph-like block of an include (a paragraph, an admonition) is
// reported against the PAGE at the include-directive line, while a trailing list
// or section is reported against the included file. Reading that attribution
// literally silently under-wrapped -- a single-block partial (a one-line
// admonition, the commonest shared fragment there is) had NO correctly-attributed
// block and so could never be factored, and a two-paragraph partial was factored
// with its second paragraph left duplicated on every consuming page.
{
  const marked = (pageSrc, fixtures) => {
    const marker = createPartialMarker()
    const reg = adoc.Extensions.create()
    // Stand in for Antora's include processor: resolve `partial$x.adoc` from the
    // fixture map and push it with the `.src`-augmented cursor file Antora uses
    // (include-processor.js), which is what makes the sentinel ids manifest-stable.
    reg.includeProcessor(function () {
      this.handles((t) => t in fixtures)
      this.process((doc, reader, target, attrs) => {
        const file = Object.assign(new String(target), {
          src: { component: 'test', module: 'ROOT', family: 'partial', relative: target.slice(target.indexOf('$') + 1) },
        })
        reader.pushInclude(fixtures[target], file, target, 1, attrs)
      })
    })
    marker.register(reg, {
      file: {
        path: 'page.adoc',
        contents: Buffer.from(pageSrc),
        src: { component: 'test', module: 'ROOT', family: 'page', relative: 'page.adoc' },
      },
    })
    // docfile must match the marker's pageFile: page-authored blocks are told
    // apart from included ones by source file.
    const doc = adoc.load(pageSrc, { sourcemap: true, safe: 'safe', extension_registry: reg, attributes: { docfile: 'page.adoc' } })
    return { html: doc.convert(), registry: marker.getRegistry() }
  }
  const between = (html, id) => {
    const s = `<!--hz-partial:start ${id}-->`
    const i = html.indexOf(s)
    return i === -1 ? null : html.slice(i + s.length, html.indexOf(`<!--hz-partial:end ${id}-->`)).trim()
  }

  // Each fragment on its own page: `partial$` content that is itself a SECTION
  // absorbs whatever follows the include (it becomes that section's body), so a
  // trailing page paragraph is only meaningful for the others.
  const cases = [
    // the regression: a partial that is ONE paragraph-like block, so its only
    // block is also its misattributed last one (no trailing newline either, as
    // nearly every hz-docs admonition partial is authored -- incidental, the
    // attribution is the same both ways)
    { target: 'partial$admon.adoc', src: 'IMPORTANT: One-line admonition, no trailing newline.', tail: true },
    { target: 'partial$twopara.adoc', src: 'Para one.\n\nPara two, trailing, no newline.', tail: true },
    { target: 'partial$listtail.adoc', src: 'Intro:\n\n- alpha\n- beta', tail: true },
    { target: 'partial$section.adoc', src: '== A Heading\n\nA paragraph under the heading.', tail: false },
  ]
  for (const c of cases) {
    const page = ['= P', '', `include::${c.target}[]`, ''].concat(c.tail ? ['Page tail.', ''] : []).join('\n')
    const { html, registry } = marked(page, { [c.target]: c.src })
    const id = `test:ROOT:${c.target}`
    assert.strictEqual(between(html, id), renderAdoc(c.src).trim(),
      `${c.target}: sentinels enclose exactly the fragment's own rendering`)
    assert.ok(registry.every((r) => r.marked), `${c.target}: the include site reports marked`)
    assert.strictEqual(stripSentinels(html).includes('hz-partial'), false, `${c.target}: no sentinel survives the strip`)
    if (c.tail) {
      assert.strictEqual(between(html, id).includes('Page tail.'), false, `${c.target}: page content stays outside the sentinels`)
    }
  }
  ok('mark-partials: wraps single-block, trailing-paragraph, section and list partials whole')

  // The trap in reading "page-attributed block on an include line" too loosely: a
  // page whose PREAMBLE opens with an include shares that include's line, so the
  // preamble itself looks like the boundary artifact. Its `<div id="preamble">`
  // chrome is the page's, and wrapping it would bake page markup into the shared
  // fragment (and vary it by consumer).
  {
    const admon = 'IMPORTANT: Shared caution.'
    const { html } = marked(['= P', '', 'include::partial$admon.adoc[]', '', '== S', '', 'Section body.', ''].join('\n'),
      { 'partial$admon.adoc': admon })
    const inner = between(html, 'test:ROOT:partial$admon.adoc')
    assert.strictEqual(inner, renderAdoc(admon).trim(), 'preamble-leading include: sentinels hold the fragment, not the preamble')
    assert.strictEqual(/preamble|sectionbody/.test(inner), false, 'preamble-leading include: no page chrome inside the sentinels')
    ok('mark-partials: a page container sharing an include line is not mistaken for the fragment')
  }

  // Fusion is the one case that must NOT be wrapped wholesale: a `+` list
  // continuation appends page content into the same list item. Wrapping the item
  // would swallow the page's own paragraph (and, on a single-use include, delete
  // it). The partial still gets sentinels, but only around its own block.
  const fused = marked(
    ['= P', '', '. Do the thing:', '+', 'include::partial$admon.adoc[]', '+', 'Page-authored follow-up.', ''].join('\n'),
    { 'partial$admon.adoc': 'IMPORTANT: Shared caution.' })
  assert.strictEqual(between(fused.html, 'test:ROOT:partial$admon.adoc'), renderAdoc('IMPORTANT: Shared caution.').trim(),
    'fused site: sentinels hold the partial only')
  assert.ok(fused.html.includes('Page-authored follow-up.'), 'fused site: the page\'s own continuation content survives')
  assert.strictEqual(between(fused.html, 'test:ROOT:partial$admon.adoc').includes('Page-authored follow-up.'), false,
    'fused site: page content is NOT dragged inside the sentinels')
  ok('mark-partials: a `+`-fused include keeps page content outside the sentinels')
}

// --- mark-conditionals: source wrap correctness ------------------------------
{
  const plain = 'no conditionals here\njust text\n'
  assert.strictEqual(wrapConditionals(plain), plain, 'no snapshot conditional -> text unchanged')

  const unterminated = 'ifdef::snapshot[]\ncontent with no endif\n'
  assert.strictEqual(wrapConditionals(unterminated), unterminated, 'unterminated ifdef left as-is')

  const src = 'ifdef::snapshot[]\ncontent line\nendif::[]'
  const wrapped = wrapConditionals(src)
  assert(wrapped.includes('ifdef::snapshot[]') && wrapped.includes('endif::[]'), 'directives kept intact')
  const iIf = wrapped.indexOf('ifdef::snapshot[]')
  const iStart = wrapped.indexOf(START)
  const iBody = wrapped.indexOf('content line')
  const iEnd = wrapped.indexOf(END)
  const iEndif = wrapped.indexOf('endif::[]')
  assert(iIf < iStart && iStart < iBody && iBody < iEnd && iEnd < iEndif,
    'sentinels sit INSIDE the conditional, around the body')
  ok('wrapConditionals: injects sentinels inside the block, leaves non-snapshot text alone')
}

// --- mark-conditionals: marking must not change the parse --------------------
// THE invariant the whole approach rests on: strip(marked golden) === clean
// golden. Asciidoctor is the oracle — render each source with the `snapshot`
// attribute set, once marked and once bare, strip the sentinels, and require the
// two to agree. An `ifdef` is invisible to the block parser, so a padded sentinel
// injected next to a line that was continuing a block ends that block and the
// render genuinely improves — which is a broken baseline, not a win.
{
  const render = (src) => adoc.convert(src, { attributes: { snapshot: '' }, safe: 'safe' })
  const roundTrips = (src) =>
    stripConditionalSentinels(render(wrapConditionals(src))) === render(src)

  // The management-center install.adoc shape: no blank line before the directive,
  // so Asciidoctor absorbs `.Debian` into the preceding paragraph. Marking would
  // promote it to a block title.
  const glued = [
    'Use either of these package managers:',
    'ifdef::snapshot[]',
    '.Debian',
    '[source,shell]',
    '----',
    'apt install hazelcast',
    '----',
    'endif::[]',
    '',
  ].join('\n')
  assert(/\.Debian/.test(render(glued)),
    'precondition: with no blank line, Asciidoctor absorbs `.Debian` into the paragraph')
  // This shape IS marked, and is the one case where the render deliberately
  // changes: the swallowed `.Debian` becomes the block title it was written as.
  assert.strictEqual(markability(glued.split('\n'), 1, 7), 'promotes-title',
    'a paragraph above a branch whose first line is a block title marks as promotes-title')
  assert(!roundTrips(glued), 'so it does NOT round-trip — the divergence is the point')
  // Bounded: the ONLY change is the promotion. Oracle is the visible text, which
  // must be identical once the title loses the leading dot it had as prose.
  const visible = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  assert.strictEqual(
    visible(stripConditionalSentinels(render(wrapConditionals(glued)))),
    visible(render(glued)).replace(' .Debian', ' Debian'),
    'nothing else about the render moves — same text, one dot fewer')
  assert(/<div class="title">Debian<\/div>/.test(render(wrapConditionals(glued))),
    'and the promotion really is a block title in the output')

  // A block that continues AFTER the endif is the mirror image of the same hazard.
  const gluedAfter = [
    '',
    'ifdef::snapshot[]',
    'snapshot text',
    'endif::[]',
    '.Trailing',
    'more text',
    '',
  ].join('\n')
  assert.strictEqual(wrapConditionals(gluedAfter), gluedAfter,
    'a line glued to the endif is left unmarked too (the hazard is symmetric)')
  assert(roundTrips(gluedAfter), 'round-trip holds for the trailing case')

  // The safe shape — blank lines on both sides — IS marked, and round-trips.
  const spaced = ['Intro paragraph.', '', 'ifdef::snapshot[]', 'snapshot only', 'endif::[]', '', 'Outro.', ''].join('\n')
  assert.notStrictEqual(wrapConditionals(spaced), spaced, 'a properly separated block is marked')
  assert(roundTrips(spaced), 'and round-trips byte-for-byte')

  // Counters are reported, so a skip is never silent.
  const stats = {}
  wrapConditionals(spaced, stats)
  wrapConditionals(glued, stats)
  wrapConditionals(gluedAfter, stats)
  assert.deepStrictEqual(stats, { marked: 1, markedPromotingTitle: 1, skipped: 1 },
    'the three outcomes are counted separately — a promoting mark is never hidden in `marked`')
  ok('wrapConditionals: only marks where injection is parse-neutral (Asciidoctor oracle)')
}

// --- the ifdef/ifndef PAIR, and comment-transparency -------------------------
// The pair is the corpus's normal shape (38 of 41 live `ifdef`s are one half of
// one), and it has no blank line between the halves by construction — so it can
// only be judged, and marked, as a UNIT.
//
// Asciidoctor is again the oracle, now in BOTH attribute states: the then-branch
// renders only with `snapshot` set and the else-branch only without it, so a pair
// that round-trips in one state proves nothing about the other.
{
  const renderWith = (src, attrs) => adoc.convert(src, { attributes: attrs, safe: 'safe' })
  const roundTripsBoth = (src) => {
    const marked = wrapConditionals(src)
    for (const attrs of [{ snapshot: '' }, {}]) {
      if (stripConditionalSentinels(renderWith(marked, attrs)) !== renderWith(src, attrs)) return false
    }
    return true
  }

  // The MC update-config shape: `endif::[]` immediately followed by the else
  // directive. Judged as one unit on its OUTER boundaries, so it marks — where
  // testing each half alone would reject it for want of an interior blank line.
  const pair = ['Intro.', '', 'ifdef::snapshot[]', 'master link', 'endif::[]',
    'ifndef::snapshot[]', 'tag link', 'endif::[]', '', 'Outro.', ''].join('\n')
  const markedPair = wrapConditionals(pair)
  assert(markedPair.includes('hz-if:snapshot:start') && markedPair.includes('hz-ifnot:snapshot:start'),
    'both halves of the pair are marked, each with its own sentinel')
  assert(roundTripsBoth(pair), 'and the render round-trips with `snapshot` both set and unset')
  const pairStats = {}
  wrapConditionals(pair, pairStats)
  assert.deepStrictEqual(pairStats, { marked: 1 }, 'a pair counts as ONE unit, not two')

  // Each branch renders only in its own state — the reason both states must be
  // checked, and the reason the current tree cannot simply wrap what it has.
  assert(/master link/.test(renderWith(pair, { snapshot: '' })) && !/tag link/.test(renderWith(pair, { snapshot: '' })),
    'with snapshot set, only the then-branch renders')
  assert(/tag link/.test(renderWith(pair, {})) && !/master link/.test(renderWith(pair, {})),
    'with snapshot unset, only the else-branch renders')

  // A standalone `ifndef` is marked as the else-branch on its own.
  const soloElse = ['Intro.', '', 'ifndef::snapshot[]', 'released only', 'endif::[]', '', 'Outro.', ''].join('\n')
  assert(wrapConditionals(soloElse).includes('hz-ifnot:snapshot:start'), 'a standalone ifndef is marked')
  assert(roundTripsBoth(soloElse), 'and round-trips in both states')

  // A `// tag::name[]` line above the directive keeps the unit UNMARKED, so it
  // bakes. Deliberate: see canMark. Treating the comment as transparent marks
  // hz-docs' install-enterprise, whose then-branch is a list item, and the padded
  // sentinel then closes the `<ol>` — parse-neutral by the blank-line test and
  // still a changed render. The shape below is that page's, reduced.
  const taggedList = ['Intro.', '', '// tag::x[]', 'ifdef::snapshot[]',
    '. first item', 'endif::[]', 'ifndef::snapshot[]', '. other first item', 'endif::[]',
    '. second item', '', 'Outro.', ''].join('\n')
  assert.strictEqual(wrapConditionals(taggedList), taggedList,
    'a tag comment above the directive is not read as a boundary, so the unit bakes')
  assert(roundTripsBoth(taggedList), 'and the golden is therefore untouched')
  ok('wrapConditionals: pairs judged as one unit; a comment is not a boundary')
}

// --- normalize-monospace: recover literal `__x` / `_` from Antora's mangling --
// Asciidoctor itself is the oracle. The bug is a CROSS-SPAN bleed: an `_`/`*` in a
// monospace span opens an emphasis that pairs with a DISTANT delimiter, so both
// spans corrupt. We prove the bug live on full lines, then that the rewrite fixes
// it AND frees the far span, and that non-firing spans are byte-identical.
{
  // Bug 1, proven live: `__trace` pairs its `__` with a later `__bold__`, so the
  // code mangles AND the bold is destroyed.
  const trace = 'use the `__trace` fn then __bold__'
  assert(/<code><em>/.test(renderAdoc(trace)),
    'precondition: `__trace` mis-renders as <code><em> (the Antora bleed)')
  const traceFixed = renderAdoc(literalizeMonospace(trace))
  assert(/<code>__trace<\/code>/.test(traceFixed) && /<em>bold<\/em>/.test(traceFixed),
    '`__trace` renders literally AND the far `__bold__` is freed to render as emphasis')

  // Bug 2, the real project-creator line: `` `_` `` steals the delimiter of the
  // following `_.keep_`, emptying the code and eating ".keep".
  const pc = 'underscore (`_`) ignored, unless _.keep_ ext'
  assert(/<code><em><\/code>/.test(renderAdoc(pc)),
    'precondition: `` `_` `` mis-renders as empty <code><em></code>')
  const pcFixed = renderAdoc(literalizeMonospace(pc))
  assert(/<code>_<\/code>/.test(pcFixed) && /<em>\.keep<\/em>/.test(pcFixed),
    '`` `_` `` renders as <code>_</code> AND the freed `_.keep_` renders as intended italic')

  // Output-neutral where emphasis was NOT firing: wrapping a mid-word underscore
  // is byte-identical (this is why cloud/operator stay unchanged), and special-
  // character escaping is preserved by the single-plus passthrough.
  for (const src of ['the `map_entry_set` method', 'see `a<b && c>d` here']) {
    assert.strictEqual(renderAdoc(literalizeMonospace(src)), renderAdoc(src),
      `non-firing / special-char monospace renders identically: ${src}`)
  }

  // Conservative skips: the source rewrite leaves these byte-identical.
  assert.strictEqual(literalizeMonospace('a `{attr_name}` ref'), 'a `{attr_name}` ref',
    'skips a span with an attribute reference (passthrough would stop {} expanding)')
  assert.strictEqual(literalizeMonospace('a `c+_d` span'), 'a `c+_d` span',
    'skips a span already containing + (would break the passthrough)')
  const block = '----\ncode with `__literal` backtick\n----\n'
  assert.strictEqual(literalizeMonospace(block), block,
    'never touches backticks inside a verbatim (----) block')
  // A lone `+` is a list-continuation, NOT a passthrough delimiter: a span AFTER
  // it must still be normalized (regression: advanced-scripting slipped through).
  assert(literalizeMonospace('* item\n+\nthen `__trace` here').includes('`+__trace+`'),
    'a lone + (list continuation) does not open a verbatim block')
  assert.strictEqual(literalizeMonospace('++++\npass `__x` through\n++++\n'),
    '++++\npass `__x` through\n++++\n', 'a real ++++ passthrough block is still skipped')
  assert.strictEqual(literalizeMonospace('plain `code` here'), 'plain `code` here',
    'leaves monospace with no emphasis chars untouched')
  ok('normalize-monospace: fixes the cross-span bleed, output-neutral + safe skips')
}

// --- lockfile-key: the snapshot pin ------------------------------------------
{
  const lf = (hashB) => ({
    sources: [
      { url: 'a', refname: 'main', startPath: '', refhash: 'sha-a' },
      { url: 'b', refname: 'v/5', startPath: 'd', refhash: hashB },
    ],
  })
  const reordered = { generatedAt: 'later', counts: { x: 1 }, sources: [lf('sha-b').sources[1], lf('sha-b').sources[0]] }
  assert.strictEqual(lockfileKey(lf('sha-b')), lockfileKey(reordered),
    'order-independent; generatedAt/counts ignored')
  assert.notStrictEqual(lockfileKey(lf('sha-b')), lockfileKey(lf('CHANGED')), 'a changed SHA changes the key')
  ok('lockfileKey: hashes pinned SHAs only, order-independent')
}

// --- manifest-index: the Layer 3 URL resolver --------------------------------
{
  assert.deepStrictEqual([...variants('/cloud/install')].sort(), ['/cloud/install', '/cloud/install/'],
    'adds the trailing-slash variant')
  assert.deepStrictEqual([...variants('/')], ['/'], 'root has no extra variant')

  const idx = buildIndex({
    site: { url: 'https://docs.hazelcast.com' },
    resources: [
      { family: 'page', url: '/cloud/install' },
      { family: 'image', url: '/cloud/img/x.png' },
      { family: 'alias', url: '/cloud/old' },
      { family: 'page', url: '/hazelcast/5.7/intro' },
      { family: 'page', url: '/operator/5.19/' },
    ],
    components: [{ name: 'hazelcast', latestVersion: '5.7', versions: [{ version: '5.8', prerelease: true }] }],
  })
  assert.strictEqual(idx.resolve('/cloud/install'), '/cloud/install', 'direct hit')
  assert(idx.has('/cloud/install/'), 'trailing-slash variant resolves')
  // The CANONICAL URL, not the variant as given: anchor lookups and the
  // baseline's problem keys join on it. A version root is served at `/x/5.19/`
  // in Antora but linked as `/x/5.19` by the trailingSlash:false site.
  assert.strictEqual(idx.resolve('/cloud/install/'), '/cloud/install', 'a slash variant resolves to the canonical URL')
  assert.strictEqual(idx.resolve('/operator/5.19'), '/operator/5.19/', 'a slashless version root resolves to the canonical URL')
  assert.strictEqual(idx.resolve('/cloud/install.html'), '/cloud/install', '.html suffix stripped to canonical')
  assert.strictEqual(idx.has('/nope'), false, 'unknown path is not served')
  assert.strictEqual(idx.kindOf('/cloud/install'), 'page', 'page family')
  assert.strictEqual(idx.kindOf('/cloud/img/x.png'), 'image', 'image family')
  assert.strictEqual(idx.kindOf('/cloud/old'), 'alias', 'alias family')
  assert.strictEqual(idx.resolve('/hazelcast/latest/intro'), '/hazelcast/5.7/intro',
    'the /latest/ alias rewrites to latestVersion and re-resolves')
  assert.strictEqual(idx.siteUrl, 'https://docs.hazelcast.com', 'site url read from manifest')
  ok('buildIndex: resolves direct / .html / trailing-slash / version-alias, classifies family')
}

// --- structure.inventory: profile matches the real Asciidoctor output --------
// The "should" for WHICH markup counts as an admonition / content table / code
// block is: whatever Asciidoctor actually emits. So render real AsciiDoc through
// the renderer and assert the inventory counts it -- a profile typo or a change
// in the renderer's classes surfaces here, not in a hand-copied HTML fixture.
{
  const src = [
    '== Heading', '',
    '[source,java]', '----', 'int x = 1;', '----', '',
    '|===', '| a | b', '| c | d', '|===', '',
    '* one', '* two', '',
    '[NOTE]', '====', 'A note.', '====', '',
    'TIP: an inline tip',
  ].join('\n')
  const inv = inventory(renderAdoc(src), ASCIIDOC_PROFILE)
  assert.strictEqual(inv.headings.h2, 1, 'section heading')
  assert.strictEqual(inv.codeBlocks, 1, 'source block')
  assert.strictEqual(inv.tables, 1, 'the |=== content table')
  assert.strictEqual(inv.listItems, 2, 'bullet items')
  assert.strictEqual(inv.admonitions.note, 1, 'block admonition [NOTE]')
  assert.strictEqual(inv.admonitions.tip, 1, 'inline admonition TIP:')
  ok('inventory: counts match the real Asciidoctor render of each construct')

  // An admonition renders as a layout <table>; it must NOT count as content.
  const admOnly = inventory(renderAdoc('[NOTE]\n====\nJust a note.\n===='), ASCIIDOC_PROFILE)
  assert.strictEqual(admOnly.tables, 0, "an admonition's layout table is not a content table")
  ok('inventory: excludes the admonition layout table from content tables')
}

// --- structure.inventory: navigable-link + cell-code exclusion rules ---------
// Three fidelity requirements, stated directly: an href with literal angle
// brackets is not a navigable link (Docusaurus rejects it, the converter drops
// the anchor); neither is an address the reader types or opens on their own
// machine, whether or not it is a valid URL; and a <pre> inside a table cell is
// cell content compared via the table-row mechanism, not a standalone code block.
{
  const links = inventory(
    '<a href="/real">real</a> <code><a class="bare" href="http://<mc-ip>:8080">ph</a></code>',
    ASCIIDOC_PROFILE)
  assert.strictEqual(links.links, 1, 'a href containing literal <> is not a navigable link')

  // Stated as the requirement, not as the regex: each of these hosts is one a
  // reader cannot reach, so the golden's autolink is not a link we owe them --
  // and a real host that merely CONTAINS one of those words still is.
  const unreachable = [
    'http://localhost:8443/swagger-ui/index.html', 'http://localhost:8080', 'https://127.0.0.1:9000/x',
    'http://0.0.0.0/', 'https://router.local/status', 'https://example.com', 'http://example.org/a',
  ]
  for (const href of unreachable) {
    assert.strictEqual(inventory(`<a href="${href}">u</a>`, ASCIIDOC_PROFILE).links, 0,
      `an address the reader cannot reach is not a navigable link: ${href}`)
  }
  const reachable = [
    'https://example.community/a', 'https://localhost.example.io/', 'https://docs.hazelcast.com/x',
    'https://mylocal.com/', '/hazelcast/5.7/getting-started/quickstart',
  ]
  for (const href of reachable) {
    assert.strictEqual(inventory(`<a href="${href}">u</a>`, ASCIIDOC_PROFILE).links, 1,
      `a real destination is still counted: ${href}`)
  }

  const cell = inventory(
    '<table class="tableblock"><tbody><tr><td><pre>in-cell</pre></td></tr></tbody></table>',
    ASCIIDOC_PROFILE)
  assert.strictEqual(cell.codeBlocks, 0, 'a <pre> inside a CONTENT table cell is not a standalone code block')
  assert.strictEqual(cell.tables, 1, 'the content table itself is counted')

  // A LAYOUT table is not a table, so its cells are not cells: Asciidoctor wraps
  // an admonition and a callout list in classless tables, and a fence written
  // inside either is a code block the reader sees -- counted, exactly as it is on
  // the Docusaurus side, where those constructs are not tables at all.
  const layouts = {
    admonition: '<div class="admonitionblock note"><table><tr><td class="icon"></td>' +
      '<td class="content"><div class="listingblock"><div class="content"><pre>in-note</pre>' +
      '</div></div></td></tr></table></div>',
    colist: '<div class="colist arabic"><table><tr><td>1</td>' +
      '<td>why<div class="listingblock"><div class="content"><pre>in-callout</pre>' +
      '</div></div></td></tr></table></div>',
  }
  for (const [kind, html] of Object.entries(layouts)) {
    const inv = inventory(html, ASCIIDOC_PROFILE)
    assert.strictEqual(inv.codeBlocks, 1, `a <pre> inside a ${kind}'s layout table IS a code block`)
    assert.strictEqual(inv.tables, 0, `a ${kind}'s layout table is not a content table`)
  }
  ok('inventory: excludes <>-href and unreachable-host links, and content-table-cell code blocks')
}

// --- layer2.compareInventory -------------------------------------------------
{
  const base = () => ({
    headings: { h1: 0, h2: 2, h3: 1, h4: 0, h5: 0, h6: 0 },
    admonitions: { note: 1, tip: 0, warning: 0, caution: 0, important: 0, unknown: 0 },
    codeBlocks: 1, tables: 1, images: 1, links: 3, listItems: 2, tabSets: 0, tabItems: 0,
  })
  assert.deepStrictEqual(compareInventory(base(), base()), [], 'identical inventories -> no diffs')

  const more = base(); more.codeBlocks = 2
  assert.deepStrictEqual(compareInventory(base(), more), [{ field: 'codeBlocks', golden: 1, converted: 2 }],
    'a differing field is reported')

  const oneH1 = base(); oneH1.headings.h1 = 1
  assert.deepStrictEqual(compareInventory(base(), oneH1), [], 'converted +1 h1 (page title) allowed leniently')
  const twoH1 = base(); twoH1.headings.h1 = 2
  assert.strictEqual(compareInventory(base(), twoH1).length, 1, 'converted +2 h1 is flagged')
  ok('compareInventory: reports field diffs, lenient on a single extra title h1')
}

// --- image IDENTITY, not just image count ------------------------------------
// The count answers "how many pictures"; nothing else in the harness answers
// "which". L1 is text (an <img> contributes none), L3 reads only <a href>, and
// the site build's onBrokenMarkdownImages proves a path RESOLVES, never that it
// resolves to the intended file. So a page can render the right number of wrong
// pictures and pass everything -- the failure mode computed image placement
// (lib/image-placement.js) can actually produce.
{
  const inv = (names) => ({
    headings: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    admonitions: { note: 0, tip: 0, warning: 0, caution: 0, important: 0, unknown: 0 },
    codeBlocks: 0, tables: 0, images: names.length, links: 0, listItems: 0, tabSets: 0, tabItems: 0,
    imageNames: names,
  })
  assert.deepStrictEqual(compareInventory(inv(['a.png', 'b.png']), inv(['a.png', 'b.png'])), [],
    'same images in the same order -> no diff')

  const swapped = compareInventory(inv(['a.png', 'b.png']), inv(['a.png', 'c.png']))
  assert.strictEqual(swapped.length, 1, 'a substituted image is reported exactly once')
  assert.strictEqual(swapped[0].field, 'imageNames')
  assert(swapped[0].golden.includes('b.png') && swapped[0].converted.includes('c.png'),
    'the diff names both sides of the substitution')
  assert(!swapped[0].golden.includes('a.png'), 'and reports only the positions that differ')

  // ORDER matters: two pages swapping each other's pictures is a real
  // regression, and a set comparison would call it clean.
  assert.strictEqual(compareInventory(inv(['a.png', 'b.png']), inv(['b.png', 'a.png'])).length, 1,
    'reordered images are a diff, not a match')

  // A length difference is already the `images` count diff; repeating it as a
  // name list would be noise, so exactly one finding is expected.
  const dropped = compareInventory(inv(['a.png', 'b.png']), inv(['a.png']))
  assert.deepStrictEqual(dropped.map((d) => d.field), ['images'],
    'a dropped image is reported by the count only, not twice')

  // Inventories predating the field (an older cache) must not read as a diff.
  const legacy = inv(['a.png']); delete legacy.imageNames
  assert.deepStrictEqual(compareInventory(legacy, legacy), [], 'inventories with no imageNames -> no diff')
  // An image webpack inlined as a base64 data URI has no name in the built HTML
  // (imageName -> null). Comparing it would false-positive on every small icon,
  // so the position is skipped -- and the positions around it must still be
  // checked, which is what this asserts.
  const withInlined = compareInventory(inv(['a.png', 'b.png', 'c.png']), inv(['a.png', null, 'c.png']))
  assert.deepStrictEqual(withInlined, [], 'an inlined (nameless) image is skipped, not reported')
  const inlinedPlusReal = compareInventory(inv(['a.png', 'b.png', 'c.png']), inv(['a.png', null, 'z.png']))
  assert.strictEqual(inlinedPlusReal.length, 1, 'a real substitution beside an inlined image is still caught')
  assert(inlinedPlusReal[0].converted.includes('z.png') && !inlinedPlusReal[0].converted.includes('null'),
    'and the inlined position is not named in the diff')

  ok('compareInventory: catches a swapped or reordered image, without double-reporting a dropped one')
}

// --- the Docusaurus profile must undo webpack's content hash -----------------
// Otherwise every single image on every page reads as a substitution.
{
  const golden = inventory('<div class="imageblock"><img src="../_images/Dashboard.png" alt="d"></div>',
    ASCIIDOC_PROFILE)
  const converted = inventory('<img src="/assets/images/Dashboard-a103b50b234f1db0ff303c271242b05c.png" alt="d">',
    DOCUSAURUS_PROFILE)
  assert.deepStrictEqual(golden.imageNames, ['Dashboard.png'], 'golden side: the file name')
  assert.deepStrictEqual(converted.imageNames, ['Dashboard.png'], 'converted side: hash stripped')
  assert.deepStrictEqual(compareInventory(golden, converted), [], 'the two sides compare equal')

  // Under ~10KB webpack inlines the image and the file name is gone from the
  // HTML altogether -- the one image identity the harness cannot check.
  const inlined = inventory('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==">', DOCUSAURUS_PROFILE)
  assert.deepStrictEqual(inlined.imageNames, [null], 'an inlined data URI yields no comparable name')
  assert.strictEqual(inlined.images, 1, 'but it is still COUNTED as an image')

  // A hyphen + hex-looking name that is NOT a 32-char content hash must survive.
  const literal = inventory('<img src="/assets/images/step-1a2b.png">', DOCUSAURUS_PROFILE)
  assert.deepStrictEqual(literal.imageNames, ['step-1a2b.png'], 'a short hyphenated name is not a hash')
  ok('inventory: image names normalise across the golden and Docusaurus profiles')
}

// --- image alt text -----------------------------------------------------------
// What a reader without the picture gets. Compared as the DECODED attribute value
// on both sides, so a double-escaped alt (`&amp;#39;` in the HTML, which a
// screen reader reads out as "ampersand hash 39") is a diff, not a match.
{
  const alts = (html, profile) => inventory(html, profile).imageAlts
  const golden = '<div class="imageblock"><img src="../_images/a.png" alt="the name \'hello\'"></div>'
  assert.deepStrictEqual(alts(golden, ASCIIDOC_PROFILE), ["the name 'hello'"], 'alt is the decoded attribute value')
  const same = '<img src="/assets/images/a-a103b50b234f1db0ff303c271242b05c.png" alt="the name &#39;hello&#39;">'
  const doubled = '<img src="/assets/images/a-a103b50b234f1db0ff303c271242b05c.png" alt="the name &amp;#39;hello&amp;#39;">'
  const g = inventory(golden, ASCIIDOC_PROFILE)
  assert.deepStrictEqual(compareInventory(g, inventory(same, DOCUSAURUS_PROFILE)), [],
    'the same text, entity-encoded differently, is equal')
  const d = compareInventory(g, inventory(doubled, DOCUSAURUS_PROFILE))
  assert.deepStrictEqual(d.map((x) => x.field), ['imageAlts'], 'a double-escaped alt is reported')
  assert(d[0].converted.includes('&#39;'), 'and the diff shows the text a reader would actually get')
  const inlined = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="other">'
  assert.deepStrictEqual(compareInventory(g, inventory(inlined, DOCUSAURUS_PROFILE)).map((x) => x.field), ['imageAlts'],
    'an inlined image still has its alt compared (the name is skipped, the alt is not)')
  const two = inventory(golden + golden, ASCIIDOC_PROFILE)
  assert.deepStrictEqual(compareInventory(two, inventory(same, DOCUSAURUS_PROFILE)).map((x) => x.field), ['images'],
    'a dropped image is reported by the count only')
  const curly = inventory('<img src="x.png" alt="Center\u2019s  browser">', ASCIIDOC_PROFILE)
  const straight = inventory('<img src="x.png" alt="Center\'s browser">', DOCUSAURUS_PROFILE)
  assert.deepStrictEqual(compareInventory(curly, straight), [],
    'typographic quotes and whitespace fold exactly as Layer 1 prose does')
  const legacy = { ...g }; delete legacy.imageAlts
  assert.deepStrictEqual(compareInventory(legacy, inventory(doubled, DOCUSAURUS_PROFILE)), [],
    'an inventory predating the field -> no diff')
  ok('inventory/compareInventory: image alt text compared by position, decoded, counts-agree only')
}

// --- extract-main: pull the comparable fragment from a full page -------------
{
  const page = '<html><body><nav class="theme-doc-breadcrumbs">crumbtrail</nav>' +
    '<main><article><div class="theme-doc-markdown">' +
    '<h1>Title</h1><p>Body <span class="popover_Tx9d">tip</span></p>' +
    '</div></article></main></body></html>'
  const main = extractMain(page)
  assert(main.includes('<p>Body'), 'keeps the body content')
  assert(!/<h1/.test(main), 'drops the page-title h1')
  assert(!main.includes('popover_Tx9d'), 'drops the inline-badge popover')
  assert(!main.includes('crumbtrail'), 'chrome outside .theme-doc-markdown is excluded')
  assert.strictEqual(extractMain('<html><body><div>no doc container</div></body></html>'), null,
    'an unrecognisable page -> null')
  ok('extractMain: isolates .theme-doc-markdown minus title/popover, null when absent')

  assert.strictEqual(extractPage(page).title, 'Title', 'extractPage returns the dropped title h1 as text')
  assert.strictEqual(extractPage(page).fragment, main, 'and the same fragment extractMain does')
  const badged = '<main><div class="theme-doc-markdown"><h1>Maps <span class="popover_x">Learn more</span></h1></div></main>'
  assert.strictEqual(extractPage(badged).title, 'Maps ', 'a badge popover inside the title is not title text')
  assert.strictEqual(extractPage('<main><div class="theme-doc-markdown"><p>x</p></div></main>').title, null,
    'no title h1 -> null')
  ok('extractPage: returns the page title separately from the comparable fragment')
}

// --- layer2.compareTitle: page title against the Antora doctitle -------------
// The manifest title is what Asciidoctor made of the `= Title` line, so
// Asciidoctor is the oracle for that side; the other side is what a reader sees
// in the built h1.
{
  const doctitle = (src) => adoc.load(src).getDocumentTitle()
  assert.deepStrictEqual(compareTitle(doctitle('= C++ Client'), 'C++ Client'), [],
    'entity-encoded doctitle equals the rendered text')
  assert.deepStrictEqual(compareTitle(doctitle("= What's New"), 'What\u2019s New'), [],
    'a typographic apostrophe compares as the character Asciidoctor produced')
  assert.deepStrictEqual(compareTitle(doctitle('= The `map` API'), 'The map API'), [],
    'inline markup in the doctitle is reduced to its text')
  assert.deepStrictEqual(compareTitle('Install  Hazelcast', 'Install Hazelcast\n'), [], 'whitespace-insensitive')
  assert.deepStrictEqual(compareTitle(doctitle('= Deploy on AWS'), 'Deploy on Azure'),
    [{ field: 'title', golden: 'Deploy on AWS', converted: 'Deploy on Azure' }], 'a different title is reported')
  assert.deepStrictEqual(compareTitle('Deploy on AWS', null),
    [{ field: 'title', golden: 'Deploy on AWS', converted: null }], 'a missing title h1 is reported')
  assert.deepStrictEqual(compareTitle(undefined, 'Anything'), [], 'no doctitle in the manifest -> nothing to compare')
  ok('compareTitle: compares visible text of the Antora doctitle and the built h1')
}

// --- layer3.checkPage: link/anchor integrity ---------------------------------
{
  const served = new Set(['/cloud/page', '/cloud/other'])
  const deps = {
    manifestIndex: { resolve: (p) => (served.has(p) ? p : null) },
    anchorIndex: new Map([['/cloud/other', new Set(['sec'])]]),
    siteHost: 'docs.hazelcast.com',
  }
  const html = [
    '<h2 id="exists">E</h2>',
    '<a href="#exists">ok-self</a>',
    '<a href="#missing">dead-self</a>',
    '<a href="/cloud/other">ok-link</a>',
    '<a href="/cloud/nope">dead-link</a>',
    '<a href="/cloud/other#sec">ok-cross</a>',
    '<a href="/cloud/other#ghost">dead-cross</a>',
    '<a href="https://external.com/x">ext</a>',
  ].join('')
  const problems = checkPage({ html, pageUrl: '/cloud/page', fragment: true }, deps)
  assert.deepStrictEqual(problems.map((p) => p.type).sort(),
    ['dead-anchor-cross', 'dead-anchor-self', 'dead-link'],
    'reports the three real breakages; valid links + external are silent')
  ok('checkPage: dead self-anchor, dead link, dead cross-anchor; skips valid + external')

  // The converted side: a golden-valid deep link whose target OUR page lost.
  const ours = new Map([['/cloud/other', new Set(['kept'])]])
  const withOurs = { ...deps, anchorIndex: new Map([['/cloud/other', new Set(['kept', 'lost'])]]),
    convertedAnchors: (u) => ours.get(u) || null }
  const cross = (href) => checkPage({ html: `<a href="${href}">x</a>`, pageUrl: '/cloud/page' }, withOurs)
  assert.deepStrictEqual(cross('/cloud/other#lost'), [{ type: 'dropped-anchor-cross', path: '/cloud/other', anchor: 'lost' }],
    'an anchor the golden target has and our target lacks is dropped-anchor-cross')
  assert.deepStrictEqual(cross('/cloud/other#kept'), [], 'an anchor both sides have is clean')
  assert.deepStrictEqual(cross('/cloud/other#ghost').map((p) => p.type), ['dead-anchor-cross'],
    'an anchor the golden never had stays dead-anchor-cross (baseline territory), not both')
  withOurs.convertedAnchors = () => null
  assert.deepStrictEqual(cross('/cloud/other#lost'), [], 'an unconverted target falls back to the golden check')
  ok('checkPage: dropped-anchor-cross judges golden-valid anchors against the converted target')
}

// --- convertedAnchorLookup: ids read from the built page ---------------------
// Docusaurus's minifier drops quotes around simple attribute values, so the
// lookup must parse, not pattern-match the quoted form.
{
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fid-anchors-'))
  fs.mkdirSync(path.join(dir, 'cloud'))
  fs.writeFileSync(path.join(dir, 'cloud', 'other.html'),
    '<html><body><nav id=navbar></nav><main><h2 id="quoted">Q</h2><span id=unquoted></span><a name="named"></a></main></body></html>')
  const look = convertedAnchorLookup(dir)
  const ids = look('/cloud/other')
  for (const id of ['quoted', 'unquoted', 'named', 'navbar']) assert(ids.has(id), `collects ${id}`)
  assert.strictEqual(look('/cloud/missing'), null, 'no built page -> null')
  fs.rmSync(dir, { recursive: true })
  ok('convertedAnchorLookup: quote-agnostic ids from the whole built page, null when unbuilt')
}

// --- baseline: subtract known-broken golden problems -------------------------
{
  assert.strictEqual(problemKey({ type: 'dead-link', path: '/x' }), 'dead-link|/x', 'dead-link key')
  assert.strictEqual(problemKey({ type: 'dead-anchor-cross', path: '/p', anchor: 'a' }), 'dead-anchor-cross|/p|a',
    'cross-anchor key includes path + anchor')
  assert.strictEqual(problemKey({ type: 'dropped-anchor-cross', path: '/p', anchor: 'a' }), 'dropped-anchor-cross|/p|a',
    'dropped-anchor key includes path + anchor')

  const baseline = new Map([['/p', new Set(['dead-link|/x'])]])
  const problems = [{ type: 'dead-link', path: '/x' }, { type: 'dead-link', path: '/y' }]
  assert.deepStrictEqual(novelProblems('/p', problems, baseline), [{ type: 'dead-link', path: '/y' }],
    'a golden-known broken link is subtracted; only NEW breakage remains')
  assert.strictEqual(novelProblems('/other', problems, baseline).length, 2, 'a page with no baseline keeps all problems')
  ok('problemKey / novelProblems: stable identity, golden breakage subtracted')
}

// --- pairing: golden-rel <-> URL <-> converted-file mapping -------------------
{
  const path = require('node:path')
  assert.strictEqual(urlFromGoldenRel('index.html'), '/', 'root index -> /')
  assert.strictEqual(urlFromGoldenRel(path.join('cloud', 'install.html')), '/cloud/install', 'page -> extensionless URL')
  assert.strictEqual(urlFromGoldenRel(path.join('cloud', 'index.html')), '/cloud/', 'directory index -> trailing-slash URL')
  assert.strictEqual(urlFromGoldenRel(path.join('hazelcast', '5.7', 'index.html')), '/hazelcast/5.7/',
    'versioned directory index -> trailing-slash URL')

  // Both disk shapes are offered for every URL, because which one a build uses
  // is a `trailingSlash` decision the harness must not encode. Under false a
  // directory-index URL like /cloud/ is build/cloud.html, not cloud/index.html.
  assert.deepStrictEqual(convertedCandidates('/b', '/cloud/install'),
    [path.join('/b', 'cloud', 'install.html'), path.join('/b', 'cloud', 'install', 'index.html')],
    'page URL -> flat file + index-file candidates (trailingSlash-agnostic)')
  assert.deepStrictEqual(convertedCandidates('/b', '/cloud/'),
    [path.join('/b', 'cloud.html'), path.join('/b', 'cloud', 'index.html')],
    'directory URL -> flat file + index-file candidates (trailingSlash-agnostic)')
  assert.deepStrictEqual(convertedCandidates('/b', '/hazelcast/5.7/'),
    [path.join('/b', 'hazelcast', '5.7.html'), path.join('/b', 'hazelcast', '5.7', 'index.html')],
    'version root -> flat file beside its own directory of children')
  assert.deepStrictEqual(convertedCandidates('/b', '/'),
    [path.join('/b', 'index.html')], 'site root -> index.html only, never ".html"')
  ok('urlFromGoldenRel / convertedCandidates: URL derivation and file candidates')
}

console.log(`\n[fidelity selftest] ${n} groups passed.`)
