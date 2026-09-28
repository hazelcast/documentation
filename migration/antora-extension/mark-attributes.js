'use strict'

// Inline counterpart to mark-partials.js. Where mark-partials wraps included
// BLOCKS in sentinels so the converter can factor MDX partials, this marks each
// resolved `{attribute}` REFERENCE so the converter can turn it back into a
// `<Variable>` reference instead of baking the resolved value. Needed for
// attributes whose resolved value is an ambiguous word (e.g. `hazelcast-cloud`
// -> "Cloud") that could not otherwise be told apart from a literal in the
// rendered golden (a page also says "Confluent Cloud").
//
// Mechanism: before render, wrap each `{name}` reference in PLAIN-TEXT sentinel
// characters -- `name{name}` -- then, after render, turn each
// resolved sentinel run into `<span class="hz-attr-name">value</span>`
// (`spanify`). Plain characters are used, NOT AsciiDoc role markup (`[.role]#…#`)
// or raw HTML, because a reference frequently reaches the body INDIRECTLY: the
// hazelcast-cloud docs set `:description:` (whose value contains `{hazelcast-
// cloud}`) and render it with `{description}` in the body. Asciidoctor expands
// that nested attribute AFTER the quotes/macros passes and special-char-escapes
// the result, so role markup and raw HTML both leak; only inert plain text
// survives the round trip. The sentinel chars (SOH/STX/ETX) never occur in
// source and pass through every substitution untouched.
//
// Two properties make this safe (verified against the cloud corpus):
//   - references are marked only in contexts that render into flow text, so the
//     span never lands in an id or an element attribute. A LINK TARGET is the
//     trap here and is skipped explicitly: `https://…/{os-version}/javadoc/…[text]`
//     renders the reference into the `href`, and a span there
//     (`href="https://…/<span class="hz-attr-os-version">…`) is malformed HTML that
//     cheerio parses as a truncated URL followed by text. It cost hazelcast 226
//     mangled javadoc links before the residue check below started catching it,
//     because stripping the spans still reproduced the clean golden byte-for-byte
//     — so nothing downstream noticed. Nothing is lost by skipping: a reference in
//     a link target is recovered instead by the converter's href-template path
//     (buildHrefVars), which is exact rather than value-matched; and
//   - stripping the spans (`stripAttrSpans`) reproduces the un-instrumented
//     golden BYTE-FOR-BYTE, so the fidelity baseline is untouched (readGolden in
//     fidelity/lib/pairing.js strips them, exactly as it strips partial
//     sentinels).
//
// Transforms the in-memory content catalog for the throwaway snapshot render
// only; the source mirrors are never touched.

// Sentinel characters (SOH/STX/ETX). Built with fromCharCode so the source file
// carries no literal control bytes, while the runtime values are the real
// control characters -- so wrapRefs (which INSERTS them as text) and SENTINEL_RUN
// (which MATCHES them in a regex) use exactly the same bytes and cannot drift.
const SOH = String.fromCharCode(1) // start of a marker: precedes the attribute NAME
const STX = String.fromCharCode(2) // separates NAME from its resolved VALUE
const ETX = String.fromCharCode(3) // ends the marker

// Which contexts are marked, and how:
//   - the document TITLE (`= …`, level 0): NOT marked. It becomes the page's
//     frontmatter `title:` (a plain string, no <Variable>), so it is baked.
//   - SECTION headings (`== …` and deeper): marked with a ROLE SPAN, not the
//     plain sentinels used elsewhere. Asciidoctor derives a heading's anchor id
//     from its TEXT with inline roles stripped, so a role span keeps the golden
//     id clean (a plain sentinel's characters would leak into the slug); the
//     converter then force-pins that id when the heading carries a <Variable>.
//   - block images (`image::…[…]`): NOT marked -- the reference is in the alt /
//     attribute list, plain text where a span cannot live. Baked.
//   - INLINE code (`` `…{name}…` ``): marked with the plain sentinels (context
//     'code'), except inside a heading. Single-backtick monospace takes normal
//     substitutions, so the sentinel survives into `<code>` and spanifies there.
//   - `:description:` entries: marked ONLY when the body renders them via
//     `{description}` (see descriptionRendered); other attribute entries baked.
// The link-macro TARGET grammar, shared with the converter (converter/lib/links.js
// LINK_TARGET, also the basis of attrHrefTemplates). Marking must skip exactly the
// targets the converter RECOVERS references from, so the two cannot disagree about
// what a link target is: a marked reference inside one is both a corrupt golden and
// a reference the href path would have restored for free.
const { LINK_TARGET } = require('../converter/lib/links')

// LINK_TARGET needs a `[` to close the target, so it does not see an UNLABELLED
// autolink -- a bare `https://docs.hazelcast.org/hazelcast-ee-docs/{ee-version}/javadoc`
// on its own. Asciidoctor autolinks that into `<a href="URL" class="bare">URL</a>`,
// putting the reference in the href AND the visible text, from ONE source
// occurrence: marking it marks both, so the href half is malformed either way and
// the whole occurrence has to be skipped. (hazelcast clients/java, v/5.5 onwards --
// found by hasAttrSpanLeak after the LINK_TARGET skip went in.) The range this
// matches also covers the labelled autolink form, so the two grammars overlap
// harmlessly; LINK_TARGET is still needed for a `link:`-prefixed target, which
// need not be a URL at all.
const BARE_URL = /(?<![\w:])https?:\/\/[^\s[\]]+/g

// Every OTHER inline macro's target. LINK_TARGET only knows `link:` and an
// autolink, so an `xref:` target went unprotected until an attribute turned up in
// one: hazelcast writes
// `xref:{page-latest-supported-mc}@management-center:monitor-imdg:monitor-dds.adoc#…[…]`,
// and marking that attribute left Antora unable to resolve the xref at all -- the
// golden kept the macro as literal text on 46 pages, which the census guard caught
// (the census, which does not mark, resolved it correctly).
//
// The rule generalises the two special cases: a reference in ANY macro target
// reaches a machine-readable coordinate, never flow text, so it is never markable.
const MACRO_TARGET = /(?<![\w:])(?:xref|link|image|video|audio):{1,2}([^\s[\]]*)\[/g

// A capture group's start offset within the match. Computed from the END of the
// match (every one of these grammars ends at the `[`) rather than by searching for
// the captured text, which goes wrong whenever the target's first character also
// occurs in the macro name -- `xref:x[` would have located the `x` of `xref`.
const captureStart = (m) => m.index + m[0].length - m[1].length - 1

const TITLE = /^\s*=\s/
const SECTION = /^\s*==+\s/
const BLOCK_IMAGE = /^\s*image::/
// An `include::` directive is machinery, not flow text: it renders nothing itself,
// and its TARGET takes attribute substitution. A sentinel there breaks the resolve
// outright -- hazelcast's get-started-cli/quickstart write
// `include::{page-latest-supported-mc}@management-center:getting-started:install.adoc[tag=cli]`,
// and marking that attribute produced 9 "target of include not found" render
// errors across the corpus. Same family as the link-target skip above: a reference
// that reaches a MACRO TARGET is never markable.
const INCLUDE = /^\s*include::/
const ATTR_ENTRY = /^\s*:([^:\s]+):/
const DELIMITERS = new Set(['----', '....', '++++', '////'])
const INLINE_IMAGE = /image:[^[\s]*\[([^\]]*)\]/g

// Does the body render `{description}` (so a marker in the :description: value
// will actually appear in the output)? Ignores the definition line itself.
function descriptionRendered (text) {
  return text.split('\n').some((l) => !/^\s*:description:/.test(l) && l.includes('{description}'))
}

// Core: walk `text` line by line and, for every UNESCAPED `{name}` reference (of
// the given names) that sits in a markable context, invoke `onRef(name)` and
// substitute its return value for the `{name}` occurrence. Returns the rewritten
// text. Both wrapRefs (transform) and wrappableRefs (collect) go through here,
// so "what counts as a preservable reference" is single-sourced and the marking
// and the checker's expectation can never drift.
function transform (text, names, onRef) {
  if (!names || !names.length) return text
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')
  // Case-insensitive, as Asciidoctor resolves references: `{Hazelcast-cloud}`
  // renders {hazelcast-cloud}'s value. `onRef` gets the canonical name.
  const RE = new RegExp(`(\\\\?)\\{(${alt})\\}`, 'gi')
  const canonical = new Map(names.map((n) => [n.toLowerCase(), n]))
  const descUsed = descriptionRendered(text)
  const lines = text.split('\n')
  let verbatim = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (verbatim) { if (trimmed === verbatim) verbatim = null; continue }
    if (DELIMITERS.has(trimmed)) { verbatim = trimmed; continue }
    if (TITLE.test(line) || BLOCK_IMAGE.test(line) || INCLUDE.test(line)) continue
    const attr = line.match(ATTR_ENTRY)
    if (attr && !(attr[1] === 'description' && descUsed)) continue
    if (!RE.test(line)) continue
    RE.lastIndex = 0
    const context = SECTION.test(line) ? 'heading' : 'flow'
    // Ranges on this line where a reference must NOT be marked, because it does
    // not render into flow text: an inline image's alt text (plain text, no span
    // can live there) and a link macro's TARGET (it renders into the `href`).
    const skipRanges = []
    let im
    while ((im = INLINE_IMAGE.exec(line)) !== null) {
      const altStart = im.index + im[0].indexOf('[') + 1
      skipRanges.push([altStart, altStart + im[1].length])
    }
    for (const re of [LINK_TARGET, MACRO_TARGET]) {
      for (const lm of line.matchAll(re)) {
        const start = captureStart(lm)
        skipRanges.push([start, start + lm[1].length])
      }
    }
    for (const um of line.matchAll(BARE_URL)) skipRanges.push([um.index, um.index + um[0].length])
    lines[i] = line.replace(RE, (whole, esc, name, offset, str) => {
      if (esc) return whole
      const backticksBefore = (str.slice(0, offset).match(/`/g) || []).length
      const inCode = backticksBefore % 2 === 1 // inside INLINE code (`…`)
      // Inline code IS markable: single-backtick monospace takes normal
      // substitutions, so a plain sentinel survives into `<code>` and spanifies
      // there. It is the only context the value reverse-map cannot reach (a
      // version glued into a filename fails its whole-token boundary), so
      // marking is the only way to keep those references. NOT in a heading
      // though: a sentinel would leak into the derived anchor id, and the role
      // span used for headings would render literally inside code.
      if (inCode && context === 'heading') return whole
      if (skipRanges.some(([a, b]) => offset >= a && offset < b)) return whole // image alt / link target
      return onRef(canonical.get(name.toLowerCase()), whole, inCode ? 'code' : context)
    })
  }
  return lines.join('\n')
}

// Rewrite marked references on ONE source file's text: `{name}` -> the sentinel
// run `name{name}` (the `{name}` still resolves at render).
// Only a heading uses the id-safe role span; flow text and inline code both take
// the plain sentinels.
function wrapRefs (text, names) {
  return transform(text, names, (name, whole, context) =>
    context === 'heading'
      ? `[.hz-attr-${name}]#${whole}#`
      : `${SOH}${name}${STX}${whole}${ETX}`)
}

// The set of attribute names (from `names`) that `text` references in a markable
// context -- i.e. the references that CAN and therefore MUST survive as a
// <Variable>. References only in non-markable contexts (the doctitle, unused
// :description:, image alt, verbatim blocks) are correctly baked and are NOT
// included.
//
// Consumed by convert.js scanPageAttrs to decide whether an attribute's value may
// be reverse-mapped in PROSE on a given page: sharing this predicate is the point,
// so "what counts as a flow-text context" has one definition and marking cannot
// drift from prose matching. (It does NOT drive refcheck's expectations -- those
// come from the independent poisoned census render, which never consults marking.)
function wrappableRefs (text, names) {
  const found = new Set()
  transform(text, names, (name, whole) => { found.add(name); return whole })
  return found
}

// Post-render: turn each resolved sentinel run into its marker span. Called by
// the snapshot builder on the rendered HTML.
const SENTINEL_RUN = new RegExp(`${SOH}([^${STX}]*)${STX}([^${ETX}]*)${ETX}`, 'g')
const spanify = (html) => html.replace(SENTINEL_RUN, (m, name, value) => `<span class="hz-attr-${name}">${value}</span>`)

// Any residual sentinel character means a marker survived into a spot spanify
// could not turn into a well-formed span (a broken run) -- a byte-faithfulness
// hazard. The snapshot builder scans for this.
const SENTINEL_CHAR = new RegExp(`[${SOH}${STX}${ETX}]`)
const hasSentinelResidue = (html) => SENTINEL_CHAR.test(html)

// The OTHER malformation, and the one the residue check cannot see: a
// WELL-FORMED marker span that spanified inside an element's attribute value.
// `stripAttrSpans` still reproduces the clean golden byte-for-byte there, so
// every downstream faithfulness check passes -- while the marked golden itself is
// unparseable, and the converter reads a truncated attribute followed by the rest
// of the tag as text. That is how a marked `{os-version}` in a link TARGET
// mangled 226 javadoc links across 66 hazelcast pages in silence.
//
// Detected structurally rather than by listing contexts: a well-formed tag never
// contains a `<` between its name and its closing `>`, so a marker span opening
// while a tag is still open is proof the span is inside an attribute value.
const SPAN_IN_ATTR = /<[a-zA-Z][^<>]*<span class="hz-attr-/
const hasAttrSpanLeak = (html) => SPAN_IN_ATTR.test(html)

// Strip the marker spans, reproducing the un-instrumented HTML byte-for-byte.
// Writer (spanify) and matcher must stay in lockstep -- keep them together.
const ATTR_SPAN_RE = /<span class="hz-attr-[^"]*">([\s\S]*?)<\/span>/g
const stripAttrSpans = (html) => html.replace(ATTR_SPAN_RE, '$1')

// The attribute name carried by a marker span's class, or null.
const attrNameFromClass = (cls) => {
  const m = /(?:^|\s)hz-attr-([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s|$)/.exec(cls || '')
  return m ? m[1] : null
}

module.exports = {
  wrapRefs, wrappableRefs, spanify, hasSentinelResidue, hasAttrSpanLeak,
  stripAttrSpans, ATTR_SPAN_RE, attrNameFromClass,
}
