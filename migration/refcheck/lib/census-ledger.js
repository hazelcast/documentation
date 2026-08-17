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

const fs = require('node:fs')

const cheerio = require('cheerio')

const { unmask, residualTokens, TOKEN_RE } = require('../../antora-extension/poison-attributes')
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
// an anchor id (and the fragment of the <a> that points at it) is DERIVED from
// heading text and slugged, so a token in a heading changes the id too and the
// case-sensitive unmask cannot restore it. Nothing else may differ.
const maskDerivedIds = (html) => html
  .replace(/\bid="[^"]*"/g, 'id="~"')
  .replace(/\bhref="#[^"]*"/g, 'href="#~"')

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
  const unmasked = unmask(fs.readFileSync(censusFile, 'utf8'), tokens)
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

module.exports = { scanCensusPage, unmaskGuard, maskDerivedIds, tokensIn }
