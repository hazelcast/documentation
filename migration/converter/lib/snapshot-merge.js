'use strict'

// Both halves of every `ifdef::snapshot` / `ifndef::snapshot` conditional, for
// one golden page.
//
// Antora resolves a snapshot conditional before parsing, so a page's golden holds
// only the half its version renders. build-snapshot.js renders every page a
// second time with `snapshot` flipped (build/golden/flip/), and the difference
// between the two renders IS the conditional content, whatever AsciiDoc context
// it sits in: a table cell, a `+` list continuation, a listing, under a comment.
// Marking the source could not reach those, because each needs its own
// parse-neutral rule and some have none.
//
// The merge returns the golden with each differing region replaced by both
// halves, each wrapped in the sentinel comments collapseSentinels turns into
// <IfSnapshot>/<IfNotSnapshot>:
//
//   <!--hz-if:snapshot:start-->     …the half a snapshot render shows…
//   <!--hz-if:snapshot:end-->
//   <!--hz-ifnot:snapshot:start-->  …the half a release render shows…
//   <!--hz-ifnot:snapshot:end-->
//
// It splices on the ORIGINAL strings (parse5 source offsets), so everything
// outside a region is byte-for-byte the golden.

const cheerio = require('cheerio')

const START = (kind) => `<!--hz-${kind}:snapshot:start-->`
const END = (kind) => `<!--hz-${kind}:snapshot:end-->`

// Leaf blocks: compared whole, never descended into. A code block cannot hold a
// wrapper, and a paragraph's inline content is below the level MDX can wrap.
const LEAF = new Set(['pre', 'code', 'p', 'a', 'span', 'strong', 'em', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const isPartialMark = (n) => n.type === 'comment' && /^\s*hz-partial:(start|end) /.test(n.data)
const kidsOf = (n) => (n.children || []).filter((c) =>
  c.type === 'tag' || (c.type === 'text' && c.data.trim()) || isPartialMark(c))
const cls = (n) => (n.attribs && n.attribs.class ? n.attribs.class.split(/\s+/) : [])
const label = (n) => n.type === 'tag' ? `${n.name}.${cls(n)[0] || ''}` : n.type

function lcsPairs (a, b) {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++
  }
  return out
}

// A parent the converter can hold a wrapper in, for a run of its children
// [from, to). The first child of a list item is its principal text (the line
// after the bullet), and a section's first child is its heading: neither can be
// wrapped on its own.
function canHold (p, from) {
  if (!p.parent) return true // the fragment root
  const c = cls(p)
  if (p.name === 'td' || p.name === 'th') return true
  if (p.name === 'li') return from > 0
  if (p.name !== 'div') return false
  if (c.includes('sectionbody') || c.includes('tab-pane')) return true
  if (/^sect[1-5]$/.test(c[0] || '')) return from > 0
  if (c.includes('content')) {
    const outer = cls(p.parent)
    return !(outer.includes('listingblock') || outer.includes('literalblock'))
  }
  return false
}

const indexIn = (node) => kidsOf(node.parent).indexOf(node)

function diffRegions (g, f) {
  const regions = []
  const walk = (gp, fp) => {
    const gk = kidsOf(gp), fk = kidsOf(fp)
    const key = (n, $) => n.type === 'text' ? n.data.trim() : $(n).toString()
    const pairs = lcsPairs(gk.map((n) => key(n, g.$)), fk.map((n) => key(n, f.$)))
    let gi = 0, fi = 0
    const run = (ge, fe) => {
      const gr = gk.slice(gi, ge), fr = fk.slice(fi, fe)
      if (!gr.length && !fr.length) return
      const descend = gr.length === fr.length && gr.every((x, k) =>
        x.type === 'tag' && fr[k].type === 'tag' && label(x) === label(fr[k]) && !LEAF.has(x.name))
      if (descend) {
        gr.forEach((x, k) => { if (g.$(x).toString() !== f.$(fr[k]).toString()) walk(x, fr[k]) })
        return
      }
      regions.push({ gp, fp, g: [gi, ge], f: [fi, fe] })
    }
    for (const [i, j] of pairs) { run(i, j); gi = i + 1; fi = j + 1 }
    run(gk.length, fk.length)
  }
  walk(g.root, f.root)
  return regions
}

// Widen a region until its parent can hold a wrapper and it does not cut a
// factored partial in half.
function widen (r) {
  for (;;) {
    const gk = kidsOf(r.gp)
    const cutsPartial = gk.slice(r.g[0], r.g[1]).some(isPartialMark) ||
      kidsOf(r.fp).slice(r.f[0], r.f[1]).some(isPartialMark)
    if (!cutsPartial && canHold(r.gp, Math.min(r.g[0], r.f[0]))) return r
    if (!r.gp.parent) return null // nowhere left to widen to
    const gi = indexIn(r.gp), fi = indexIn(r.fp)
    r = { gp: r.gp.parent, fp: r.fp.parent, g: [gi, gi + 1], f: [fi, fi + 1] }
  }
}

const within = (node, ancestor) => { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false }

// Overlapping regions in one parent become one; a region inside another drops.
function consolidate (regions) {
  const byParent = new Map()
  for (const r of regions) {
    const prev = byParent.get(r.gp) || []
    const hit = prev.find((q) => q.g[0] <= r.g[1] && r.g[0] <= q.g[1] && q.f[0] <= r.f[1] && r.f[0] <= q.f[1])
    if (hit) {
      hit.g = [Math.min(hit.g[0], r.g[0]), Math.max(hit.g[1], r.g[1])]
      hit.f = [Math.min(hit.f[0], r.f[0]), Math.max(hit.f[1], r.f[1])]
    } else {
      prev.push(r)
      byParent.set(r.gp, prev)
    }
  }
  const all = [...byParent.values()].flat()
  return all.filter((r) => !all.some((q) => q !== r && kidsOf(q.gp).slice(q.g[0], q.g[1]).some((n) => within(r.gp, n))))
}

// Source span of kids [from, to) of `parent`; an empty run is an insertion point.
function span (parent, from, to) {
  const k = kidsOf(parent)
  if (from < to) return [k[from].sourceCodeLocation.startOffset, k[to - 1].sourceCodeLocation.endOffset]
  if (from > 0) { const at = k[from - 1].sourceCodeLocation.endOffset; return [at, at] }
  if (k.length) { const at = k[0].sourceCodeLocation.startOffset; return [at, at] }
  const loc = parent.sourceCodeLocation
  const at = loc ? (loc.startTag ? loc.startTag.endOffset : loc.startOffset) : 0
  return [at, at]
}

const load = (html) => {
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true }, false)
  return { $, root: $.root()[0] }
}

// goldenIsSnapshot: whether the golden (this version's own render) had `snapshot`
// set, i.e. which half it is. Returns { html, regions, refused }.
function mergeSnapshotHalves (golden, flip, goldenIsSnapshot) {
  if (flip == null || flip === golden) return { html: golden, regions: 0, refused: 0 }
  const g = load(golden), f = load(flip)
  let refused = 0
  const widened = []
  for (const r of diffRegions(g, f)) {
    const w = widen(r)
    if (w) widened.push(w)
    else refused++
  }
  if (refused) return { html: golden, regions: 0, refused }
  const edits = consolidate(widened).map((r) => {
    const [gs, ge] = span(r.gp, r.g[0], r.g[1])
    const [fs, fe] = span(r.fp, r.f[0], r.f[1])
    const halves = goldenIsSnapshot
      ? { if: golden.slice(gs, ge), ifnot: flip.slice(fs, fe) }
      : { if: flip.slice(fs, fe), ifnot: golden.slice(gs, ge) }
    const wrap = (kind) => halves[kind].trim() ? `\n${START(kind)}\n${halves[kind]}\n${END(kind)}\n` : ''
    return { gs, ge, text: wrap('if') + wrap('ifnot') }
  })
  let html = golden
  for (const e of edits.sort((a, b) => b.gs - a.gs)) html = html.slice(0, e.gs) + e.text + html.slice(e.ge)
  return { html, regions: edits.length, refused: 0 }
}

// The golden page back out of a merged page: drop the half it does not render,
// then the sentinels. Used by the selftest as the round-trip oracle.
function renderedHalf (merged, snapshot) {
  const drop = snapshot ? 'ifnot' : 'if'
  const re = new RegExp(`\\n${START(drop)}\\n[\\s\\S]*?\\n${END(drop)}\\n`, 'g')
  const keep = snapshot ? 'if' : 'ifnot'
  return merged.replace(re, '').replace(new RegExp(`\\n${START(keep)}\\n|\\n${END(keep)}\\n`, 'g'), '')
}

module.exports = { mergeSnapshotHalves, renderedHalf }
