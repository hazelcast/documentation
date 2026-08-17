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
//     span never lands in an id or an element attribute; and
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
const TITLE = /^\s*=\s/
const SECTION = /^\s*==+\s/
const BLOCK_IMAGE = /^\s*image::/
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
  const RE = new RegExp(`(\\\\?)\\{(${alt})\\}`, 'g')
  const descUsed = descriptionRendered(text)
  const lines = text.split('\n')
  let verbatim = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (verbatim) { if (trimmed === verbatim) verbatim = null; continue }
    if (DELIMITERS.has(trimmed)) { verbatim = trimmed; continue }
    if (TITLE.test(line) || BLOCK_IMAGE.test(line)) continue
    const attr = line.match(ATTR_ENTRY)
    if (attr && !(attr[1] === 'description' && descUsed)) continue
    if (!RE.test(line)) continue
    RE.lastIndex = 0
    const context = SECTION.test(line) ? 'heading' : 'flow'
    // Inline-image alt-text ranges on this line (plain text -> skip).
    const imgRanges = []
    let im
    while ((im = INLINE_IMAGE.exec(line)) !== null) {
      const altStart = im.index + im[0].indexOf('[') + 1
      imgRanges.push([altStart, altStart + im[1].length])
    }
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
      if (imgRanges.some(([a, b]) => offset >= a && offset < b)) return whole // inside image alt
      return onRef(name, whole, inCode ? 'code' : context)
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
  wrapRefs, wrappableRefs, spanify, hasSentinelResidue,
  stripAttrSpans, ATTR_SPAN_RE, attrNameFromClass,
}
