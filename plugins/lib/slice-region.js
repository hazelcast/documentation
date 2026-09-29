'use strict'

// The one implementation of `include::[tag=…]` region slicing, shared by the tag-slice webpack loader
// (plugins/example-attributes) and the converter's example index so they cannot disagree.
// Files stay complete and compilable; slicing happens at read time, never baked.

// A tag/end directive line of any name; all such lines are stripped so nested markers never show.
const DIRECTIVE_LINE = /(?:^|[^\w:])(?:tag|end)::[^[\]]*\[\]/

// Asciidoctor drops a leading UTF-8 BOM. Staged copies keep it (upstream hashes are verified against the
// original bytes), so it comes off here, the one point the converter index and the loader share.
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const markerFor = (kind, name) => new RegExp(`(?:^|[^\\w:])${kind}::${esc(name)}\\[\\]`)

// `lines=` value -> [[from, to]], 1-indexed inclusive; `to === -1` means end of file.
function parseLineRanges (spec) {
  const ranges = []
  for (const part of String(spec).split(/[;,]/)) {
    const s = part.trim()
    if (!s) continue
    const m = s.match(/^(\d+)(?:\.\.(-1|\d+))?$/)
    if (!m) throw new Error(`unparseable lines= range ${JSON.stringify(s)}`)
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (from < 1) throw new Error(`lines= is 1-indexed, got ${JSON.stringify(s)}`)
    ranges.push([from, to])
  }
  if (!ranges.length) throw new Error('lines= names no range')
  return ranges
}

// Normalises a callout written as a line comment (`foo(); // <1>`) to a bare `<N>`, as the swizzled CodeBlock expects.
const normalizeCallouts = (line) =>
  line.replace(/(?:\/\/|#|--|;;) ?((?:<\d+> ?)*<\d+>)[ \t]*$/, '$1')

// `indent=0` on the listing block: reindent so the least-indented line is at column 0 (blank lines ignored).
function dedent (lines) {
  let min = Infinity
  for (const l of lines) {
    if (!l.trim()) continue
    min = Math.min(min, l.length - l.replace(/^[ \t]+/, '').length)
  }
  if (!isFinite(min) || min === 0) return lines
  return lines.map((l) => (l.trim() ? l.slice(min) : l))
}

// Drops trailing blank lines and ends with exactly one newline (theme-common strips one).
function normalizeTail (lines) {
  const out = lines.slice()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.length ? out.join('\n') + '\n' : ''
}

// Shared tail of every selection path: strip directives, normalise callouts, optionally dedent.
function finish (lines, selector) {
  // Trailing whitespace is kept, as Asciidoctor does in listing blocks.
  let out = lines.filter((l) => !DIRECTIVE_LINE.test(l)).map(normalizeCallouts)
  if (selector && String(selector.indent) === '0') out = dedent(out)
  return normalizeTail(out)
}

// source: raw file text. selector: { tag } | { lines } | null (whole file). `where` names the file in errors.
// Throws on an absent or unterminated tag: an empty code block must fail the build, not ship.
function sliceRegion (source, selector, where = 'example') {
  const lines = stripBom(String(source)).split('\n')
  if (!selector || (selector.tag == null && selector.lines == null)) {
    return finish(lines, selector)
  }

  if (selector.lines != null) {
    const picked = []
    for (const [from, to] of parseLineRanges(selector.lines)) {
      const end = to === -1 ? lines.length : to
      if (from > lines.length) throw new Error(`${where}: lines=${selector.lines} starts past end of file (${lines.length} lines)`)
      picked.push(...lines.slice(from - 1, end))
    }
    return finish(picked, selector)
  }

  const name = selector.tag
  // Wildcards are unsupported; refuse rather than mis-slice.
  if (/\*/.test(name)) throw new Error(`${where}: tag wildcards are not supported (${JSON.stringify(name)})`)
  // Tag lists (`a;b`) and negation (`!a`) go through selectTagSet.
  if (/[;,!]/.test(name)) return finish(selectTagSet(lines, name, where), selector)

  const startRe = markerFor('tag', name)
  const endRe = markerFor('end', name)
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) throw new Error(`${where}: no region tagged ${JSON.stringify(name)}`)
  const rel = lines.slice(start + 1).findIndex((l) => endRe.test(l))
  if (rel === -1) throw new Error(`${where}: region ${JSON.stringify(name)} is opened but never closed (no end::${name}[])`)

  return finish(lines.slice(start + 1, start + 1 + rel), selector)
}

// `a;b` = union of regions, `!a` = everything outside a region; they combine. Membership is a set because
// tags nest. Absent or unclosed tags throw, as in the single-tag path.
function selectTagSet (lines, spec, where) {
  const parts = spec.split(/[;,]/).map((t) => t.trim()).filter(Boolean)
  const positive = parts.filter((t) => !t.startsWith('!'))
  const negative = parts.filter((t) => t.startsWith('!')).map((t) => t.slice(1)).filter(Boolean)

  for (const name of [...positive, ...negative]) {
    if (!lines.some((l) => markerFor('tag', name).test(l))) throw new Error(`${where}: no region tagged ${JSON.stringify(name)}`)
    if (!lines.some((l) => markerFor('end', name).test(l))) throw new Error(`${where}: region ${JSON.stringify(name)} is opened but never closed (no end::${name}[])`)
  }

  const active = new Set()
  const picked = []
  for (const line of lines) {
    const m = line.match(/(?:^|[^\w:])(tag|end)::([^[\]]*)\[\]/)
    if (m) {
      if (m[1] === 'tag') active.add(m[2])
      else active.delete(m[2])
      continue
    }
    if (negative.some((n) => active.has(n))) continue
    // A pure-negation spec selects everything not excluded.
    if (!positive.length || positive.some((t) => active.has(t))) picked.push(line)
  }
  return picked
}

// Query-encode a selector for an import request. `!` must be escaped: webpack reads it as the
// inline-loader separator.
const encodeSelector = (s) => encodeURIComponent(s).replace(/!/g, '%21')

// Every slice a file offers, as { selector, query, content } entries for the converter's index. Both the
// as-authored and dedented forms are offered because dedenting is a property of the page, not the file.
function allRegions (source, extraSelectors = []) {
  const names = new Set()
  for (const line of String(source).split('\n')) {
    const m = line.match(/(?:^|[^\w:])tag::([^[\]]*)\[\]/)
    if (m && m[1]) names.add(m[1])
  }

  const out = []
  const seen = new Set()
  const add = (selector, query) => {
    let content
    try { content = sliceRegion(source, selector) } catch { return }
    // Skip a form identical to one already offered.
    if (!content || seen.has(content)) return
    seen.add(content)
    out.push({ selector, query, content })
  }
  // The unqueried entry is the raw file, matching what the loader emits with no query.
  const raw = stripBom(String(source))
  if (raw.trim()) { out.push({ selector: null, query: '', content: raw }); seen.add(raw) }
  add({ indent: '0' }, '?indent=0')
  for (const name of names) {
    add({ tag: name }, `?tag=${encodeSelector(name)}`)
    add({ tag: name, indent: '0' }, `?tag=${encodeSelector(name)}&indent=0`)
  }
  // Selectors that can't be enumerated from the file (tag lists, negations); add() swallows a spec naming a region this file lacks.
  for (const spec of extraSelectors) {
    add({ tag: spec }, `?tags=${encodeSelector(spec)}`)
    add({ tag: spec, indent: '0' }, `?tags=${encodeSelector(spec)}&indent=0`)
  }
  return out
}

module.exports = { sliceRegion, allRegions, parseLineRanges, stripBom }
