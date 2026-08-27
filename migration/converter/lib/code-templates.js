'use strict'

// The VERBATIM-BLOCK counterpart to links.js attrHrefTemplates: the lines a page
// writes inside a code block with an `{attribute}` in them, so the converter can
// recognise the rendered line by string equality and re-emit the source's own
// template with its `{name}` intact.
//
// Why a template rather than the value reverse-map: the map is keyed by VALUE, and
// a value does not identify an attribute. hazelcast has three attributes holding
// `5.8.0-SNAPSHOT` at once — {os-version}, {ee-version} and {full-version} — and
// 14 pages reference two of the three. So value->name is not a function there, and
// whichever name won the map was emitted for all of them: deploying-with-docker
// came out with 18 `{ee-version}` references where 16 of them are `{os-version}`.
//
// That is not cosmetic. The three attributes genuinely diverge: at 5.5,
// os-version is `5.5.0` while ee-version is `5.5.10`, so a mis-named reference
// prints the Community version in an Enterprise docker command — silently, and
// invisibly to the fidelity harness, which sees a correct value either way.
//
// TWO UNITS, tried in order, because neither alone is enough:
//
//   - the whole BLOCK. Needed where a line is ambiguous on its own: hazelcast's
//     pipelines/cdc-postgres renders `           <version>5.8.0-SNAPSHOT</version>`
//     twice, once from `{os-version}` and once from `{ee-version}`, and only the
//     `<artifactId>` lines around it say which is which.
//   - failing that, the LINE. Needed where the block did not survive intact
//     between source and render -- an `include::` expanded inside it, a conum
//     lifted out, a tag slice -- but the line itself did, which is the common
//     case (`hazelcast/hazelcast:{os-version}` versus
//     `hazelcast/hazelcast-enterprise:{ee-version}`).
//
// Either way the key is TEXT the source actually wrote, so it names the attribute.
// A value-level key cannot: that is the whole problem.

// Verbatim block delimiters. `----` (listing, incl. `[source]`), `....`
// (literal), `++++` (passthrough) — the same set mark-attributes refuses to mark
// inside, for the same reason: these are the contexts a marker cannot reach, so
// they are exactly the ones needing a template instead.
const DELIMITERS = new Set(['----', '....', '++++'])
// Asciidoctor STRIPS trailing whitespace from a verbatim line, so a source line
// written `… [blue] [{ee-version}] ` renders as `… [blue] [5.8.0-SNAPSHOT]` and an
// untrimmed template can never match it -- 6 occurrences over 3 hazelcast pages
// (the console-output blocks in deploy-blue-green-tutorial, wan-replication-tutorial
// and validating-secrets, all of which end a log line with a stray space).
// Normalising both sides is safe and symmetric: the render has already lost that
// whitespace, so trimming the template cannot lose anything the reader would see,
// and the template we emit then matches the golden byte for byte.
const rtrimLines = (text) => text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
const BACKTICK_FENCE = /^\s*```/
const ATTR_REF = /\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/

// Every line inside a verbatim block of `text` that carries an `{attribute}`
// reference, with LEADING whitespace kept (the rendered line keeps it) and trailing
// whitespace dropped (the rendered line does not -- see rtrimLines).
// Deliberately NOT filtered by `subs="attributes+"`: a block without it renders
// the braces literally, so its "resolved" form never matches anything and the
// entry is inert. Filtering would mean re-implementing Asciidoctor's subs rules
// to no benefit.
function attrCodeTemplates (text) {
  const lines = new Set()
  const blocks = new Set()
  if (!text) return { lines, blocks }
  let verbatim = null
  let current = null
  const closeBlock = () => {
    if (current && current.some((l) => ATTR_REF.test(l))) blocks.add(current.join('\n'))
    current = null
  }
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (verbatim) {
      if (verbatim === '```' ? BACKTICK_FENCE.test(line) : trimmed === verbatim) {
        closeBlock()
        verbatim = null
        continue
      }
      const trimmedEnd = line.replace(/[ \t]+$/, '')
      current.push(trimmedEnd)
      if (ATTR_REF.test(trimmedEnd)) lines.add(trimmedEnd)
      continue
    }
    if (DELIMITERS.has(trimmed)) { verbatim = trimmed; current = [] } else if (BACKTICK_FENCE.test(line)) { verbatim = '```'; current = [] }
  }
  closeBlock() // an unterminated block at EOF still carries usable text
  return { lines, blocks }
}

// resolvedLine -> the source template that produced it, for the templates whose
// every `{name}` is single-sourced on this page (`known`). Two rejections, both
// "we cannot be sure, so bake and let the gate say so" rather than guess:
//
//   - a template naming an attribute the site has no variable for would emit
//     literal braces into a code block;
//   - two DIFFERENT templates resolving to the same line (`<version>{os-version}</version>`
//     and `<version>{ee-version}</version>` would, if a page had both) are exactly
//     the ambiguity this exists to remove, so the line is dropped from the map.
//
// `substitute` is the same function the build-time loader and <Variable> use, so a
// template's resolved form here is byte-identical to what Antora rendered.
function resolveTemplates (templates, known, lookup, substitute) {
  const byResolved = new Map()
  const ambiguous = new Set()
  for (const tpl of templates || []) {
    const names = [...tpl.matchAll(/\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g)].map((m) => m[1])
    if (!names.length || !names.every((n) => known.has(n))) continue
    const resolved = substitute(tpl, lookup)
    if (resolved === tpl) continue
    const prev = byResolved.get(resolved)
    if (prev !== undefined && prev !== tpl) { ambiguous.add(resolved); continue }
    byResolved.set(resolved, tpl)
  }
  for (const key of ambiguous) byResolved.delete(key)
  return byResolved
}

// Both tiers at once: { blocks, lines }, each a resolved-text -> template map.
function buildCodeTemplates ({ blocks, lines }, known, lookup, substitute) {
  return {
    blocks: resolveTemplates(blocks, known, lookup, substitute),
    lines: resolveTemplates(lines, known, lookup, substitute),
  }
}

module.exports = { attrCodeTemplates, buildCodeTemplates, resolveTemplates, rtrimLines, DELIMITERS }
