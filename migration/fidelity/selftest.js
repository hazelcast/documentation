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
  GOLDEN_STRIP, GOLDEN_TABLE,
} = require('./lib/layer1')
const { stripSentinels } = require('../antora-extension/mark-partials')
const { wrapConditionals, markability, stripConditionalSentinels, START, END } = require('../antora-extension/mark-conditionals')
const { literalizeMonospace } = require('../antora-extension/normalize-monospace')
const { lockfileKey } = require('./lockfile-key')
const { buildIndex, variants } = require('./lib/manifest-index')
const { inventory, ASCIIDOC_PROFILE } = require('./lib/structure')
const { compareInventory } = require('./lib/layer2')
const { extractMain } = require('./lib/extract-main')
const { checkPage } = require('./lib/layer3')
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
    ],
    components: [{ name: 'hazelcast', latestVersion: '5.7', versions: [{ version: '5.8', prerelease: true }] }],
  })
  assert.strictEqual(idx.resolve('/cloud/install'), '/cloud/install', 'direct hit')
  assert(idx.has('/cloud/install/'), 'trailing-slash variant resolves')
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
// Two fidelity requirements, stated directly: an href with literal angle
// brackets is not a navigable link (Docusaurus rejects it, the converter drops
// the anchor), and a <pre> inside a table cell is cell content compared via the
// table-row mechanism, not a standalone code block.
{
  const links = inventory(
    '<a href="/real">real</a> <code><a class="bare" href="http://<mc-ip>:8080">ph</a></code>',
    ASCIIDOC_PROFILE)
  assert.strictEqual(links.links, 1, 'a href containing literal <> is not a navigable link')

  const cell = inventory(
    '<table class="tableblock"><tbody><tr><td><pre>in-cell</pre></td></tr></tbody></table>',
    ASCIIDOC_PROFILE)
  assert.strictEqual(cell.codeBlocks, 0, 'a <pre> inside a table cell is not a standalone code block')
  assert.strictEqual(cell.tables, 1, 'the content table itself is counted')
  ok('inventory: excludes <>-href links and in-cell code blocks')
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

// --- extract-main: pull the comparable fragment from a full page -------------
{
  const page = '<html><body><nav class="theme-doc-breadcrumbs">crumbtrail</nav>' +
    '<main><article><div class="theme-doc-markdown">' +
    '<h1>Title</h1><p>Body <span class="popover_Tx9d">tip</span></p>' +
    '</div></article></main></body></html>'
  const main = extractMain(page)
  assert(main.includes('<p>Body'), 'keeps the body content')
  assert(!/<h1/.test(main), 'drops the page-title h1 (checked via frontmatter, not here)')
  assert(!main.includes('popover_Tx9d'), 'drops the inline-badge popover')
  assert(!main.includes('crumbtrail'), 'chrome outside .theme-doc-markdown is excluded')
  assert.strictEqual(extractMain('<html><body><div>no doc container</div></body></html>'), null,
    'an unrecognisable page -> null')
  ok('extractMain: isolates .theme-doc-markdown minus title/popover, null when absent')
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
}

// --- baseline: subtract known-broken golden problems -------------------------
{
  assert.strictEqual(problemKey({ type: 'dead-link', path: '/x' }), 'dead-link|/x', 'dead-link key')
  assert.strictEqual(problemKey({ type: 'dead-anchor-cross', path: '/p', anchor: 'a' }), 'dead-anchor-cross|/p|a',
    'cross-anchor key includes path + anchor')

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

  assert.deepStrictEqual(convertedCandidates('/b', '/cloud/install'),
    [path.join('/b', 'cloud', 'install.html'), path.join('/b', 'cloud', 'install', 'index.html')],
    'page URL -> flat file + index-file candidates (trailingSlash-agnostic)')
  assert.deepStrictEqual(convertedCandidates('/b', '/cloud/'),
    [path.join('/b', 'cloud', 'index.html')], 'directory URL -> index-file candidate')
  ok('urlFromGoldenRel / convertedCandidates: URL derivation and file candidates')
}

console.log(`\n[fidelity selftest] ${n} groups passed.`)
