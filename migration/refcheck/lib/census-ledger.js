'use strict'

// EXPECTED side of the no-baking check, read from the census render (see
// antora-extension/poison-attributes.js) instead of parsed out of AsciiDoc.
//
// Each census page is HTML in which every content attribute resolved to a unique
// token, so scanning it answers, per page and PER OCCURRENCE, "which attributes
// flowed here, how many times, and into what position?". Asciidoctor did the
// include expansion, tag slicing, ifdef evaluation and nested `{description}`
// substitution, so there is no source walker to approximate any of it, and the
// real values are never matched -- a page that merely contains the literal
// "5.7.0" cannot register as a reference to a 5.7.0-valued attribute.
//
// Two products:
//   ledgerForPage()  -- expected preserved reference counts per attribute name,
//                       plus the recorded bakes (dispositions).
//   unmaskGuard()     -- proof that poisoning changed only the substituted text:
//                       putting the real values back must reproduce the golden.
//   hiddenBranchComponents()
//                    -- which `snapshot` conditional branch this version's render
//                       did NOT keep, so the MDX side can ignore the copy of it
//                       that splicing put in every version.

const fs = require('node:fs')

const cheerio = require('cheerio')

const { unmask, residualTokens, TOKEN_RE } = require('../../antora-extension/poison-attributes')
const { stripConditionalSentinels } = require('../../antora-extension/mark-conditionals')
const { readGolden } = require('../../fidelity/lib/pairing')
const { dispositionForText, dispositionForAttr, isPreserve } = require('./bake-contexts')

// token -> census entry ({ name, value, rendered, ... }).
const tokenIndex = (tokens) => new Map(tokens.map((t) => [t.token, t]))

// Every token hit in a string, in order.
function tokensIn (str) {
  return str.match(TOKEN_RE) || []
}

// Scan one census page. Returns:
//   preserve  Map(name -> count)   references the MDX must still carry
//   bakes     [{ name, disposition }]  recorded, structurally-impossible ones
//   unknown   [{ name, tag, attr }]    unrecognised position -> caller must fail
function scanCensusPage (html, { tokens }) {
  const byToken = tokenIndex(tokens)
  const preserve = new Map()
  const bakes = []
  const unknown = []

  const add = (map, name) => map.set(name, (map.get(name) || 0) + 1)
  const record = (name, disposition, where) => {
    if (disposition == null) { unknown.push({ name, ...where }); return }
    if (isPreserve(disposition)) add(preserve, name)
    else bakes.push({ name, disposition })
  }
  // Tokens are matched case-insensitively (a heading's slugged id lower-cases
  // them), so normalise before looking the name up.
  const nameOf = (token) => {
    const e = byToken.get(token.toUpperCase())
    return e ? e.name : null
  }

  const $ = cheerio.load(html, null, false)

  // Walk the tree carrying the positional facts a disposition depends on.
  const walk = (node, ctx) => {
    if (node.type === 'text') {
      for (const token of tokensIn(node.data || '')) {
        const name = nameOf(token)
        if (name) record(name, dispositionForText(ctx.textContext), { tag: ctx.tag, attr: null })
      }
      return
    }
    if (node.type !== 'tag') return

    const tag = node.name
    // Inside code/pre stays code even through nested spans (highlight.js markup).
    const next = {
      tag,
      textContext: ctx.textContext === 'code' || tag === 'code' || tag === 'pre' ? 'code'
        : /^h[1-6]$/.test(tag) ? 'heading'
          : ctx.textContext,
    }

    for (const [attr, value] of Object.entries(node.attribs || {})) {
      const raw = String(value)
      const hits = tokensIn(raw)
      if (!hits.length) continue
      const key = attr === 'href' && raw.startsWith('#') ? 'href#' : attr
      for (const token of hits) {
        const name = nameOf(token)
        if (name) record(name, dispositionForAttr(key), { tag, attr: key })
      }
    }

    for (const child of node.children || []) walk(child, next)
  }

  for (const node of $.root()[0].children || []) walk(node, { tag: null, textContext: 'text' })
  return { preserve, bakes, unknown }
}

// Mask the positions poisoning legitimately changes beyond the substituted text:
// an anchor id (and every reference to it) is DERIVED from the text it names and
// slugged, so a token in that text changes the id too and the case-sensitive
// unmask cannot restore it. Nothing else may differ.
//
// Three forms, all the same fact: the id itself; the fragment of the `<a>` that
// points at it; and a tab pane's `aria-labelledby`, which names its TAB's id --
// derived from the tab's LABEL, so hazelcast's `{enterprise-product-name}::` /
// `{open-source-product-name}::` tabsets put a slugged token there. Masking only
// the first two failed those four pages outright: every one of their eight diff
// lines was a derived tab id, half of them in the reference rather than the id
// (`aria-labelledby="tabset1_hzref0052x"` vs `..._enterprise-edition`).
const maskDerivedIds = (html) => html
  .replace(/\bid="[^"]*"/g, 'id="~"')
  .replace(/\bhref="#[^"]*"/g, 'href="#~"')
  .replace(/\baria-labelledby="[^"]*"/g, 'aria-labelledby="~"')

// The guard that makes the census trustworthy: put the real values back and the
// census page must reproduce the golden. Any difference beyond derived anchor ids
// means poisoning changed the render itself (a flipped ifeval, a dropped include,
// a broken image path) and the ledger built from it cannot be believed.
//
// Returns { verdict, residual } where verdict is:
//   'identical'      byte-for-byte
//   'anchor-derived' equal once derived ids are masked (expected on any page with
//                    an attribute in a heading)
//   'differs'        a real structural difference -- a hard error
function unmaskGuard (censusFile, goldenFile, tokens) {
  // Both sides are read DE-INSTRUMENTED. The census carries conditional sentinels
  // (build-snapshot runs mark-conditionals for the census too, because that pass
  // can change the render and an unmarked census then cannot reproduce the golden)
  // and the golden carries all three instrumentations; readGolden strips its lot,
  // so the census needs the one stripper that applies to it.
  const unmasked = unmask(stripConditionalSentinels(fs.readFileSync(censusFile, 'utf8')), tokens)
  const golden = readGolden(goldenFile)
  if (unmasked === golden) return { verdict: 'identical', residual: residualTokens(unmasked) }
  // Residuals are counted on the MASKED form: a token inside a derived anchor id
  // is slugged (lower-cased) and so is genuinely unrecoverable by substitution --
  // expected, not a leak. Anything still unrecovered outside an id is a leak.
  const maskedCensus = maskDerivedIds(unmasked)
  const residual = residualTokens(maskedCensus)
  if (maskedCensus === maskDerivedIds(golden)) return { verdict: 'anchor-derived', residual }
  return { verdict: 'differs', residual }
}

// --- which conditional branch did THIS version render? ------------------------
// The converter puts BOTH halves of a `snapshot` conditional in every version's
// MDX -- the half this version's source resolved, plus the other half spliced in
// from a version that resolved it (converter/convert.js
// withBothConditionalBranches) -- so that a `docusaurus docs:version` cut carries
// both and <IfSnapshot>/<IfNotSnapshot> pick one at build time.
//
// The census is ONE version's render, so it can only ever account for the half
// that version resolved. Counting the hidden half on the MDX side is therefore a
// surplus the census can never explain: it reported install.adoc as
// OVER-variableised (expected 4, found 6) purely because both halves reference
// {full-version}. The fix is not to relax the accounting but to compare like with
// like -- drop the branch this version does not render before counting.
//
// The evidence is the census render itself: mark-conditionals' sentinels sit
// INSIDE each branch, so they are present exactly when that branch is. Reading it
// off the page rather than off a per-version `snapshot` flag keeps the gate honest
// about pages whose conditional was left unmarked (it bakes, no sentinels, no
// wrapper in the MDX either -- nothing to drop, and a bake there is still caught).
const BRANCH_COMPONENT = { if: 'IfSnapshot', ifnot: 'IfNotSnapshot' }
const BRANCH_START_RE = /<!--hz-(if|ifnot):snapshot:start-->/g

// The branch kinds the render kept, e.g. Set { 'if' }.
function renderedBranches (html) {
  const kinds = new Set()
  for (const m of html.matchAll(BRANCH_START_RE)) kinds.add(m[1])
  return kinds
}

// The MDX components whose content this version does NOT render, so the reference
// counter must skip them. A page with no marked conditional yields both names,
// which is a no-op on a page that has no such wrapper.
function hiddenBranchComponents (censusHtml) {
  const kept = renderedBranches(censusHtml)
  return Object.entries(BRANCH_COMPONENT).filter(([kind]) => !kept.has(kind)).map(([, tag]) => tag)
}

module.exports = {
  scanCensusPage, unmaskGuard, maskDerivedIds, tokensIn, renderedBranches, hiddenBranchComponents,
}
