'use strict'

// The ONE implementation of Antora/Asciidoctor `include::…[tag=…]` region
// slicing. Shared by the build-time tag-slice webpack loader (plugins/
// tag-slice-loader.js) and, during the migration, by the converter's
// content-addressed example index -- the same arrangement as
// substitute-attributes.js, so the two cannot drift and disagree about what a
// given slice contains.
//
// Platform's examples are complete, compilable .java files: the `package` and
// `import` lines sit OUTSIDE the tag markers so the file stays a valid
// compilation unit while a page shows only the interesting region. Slicing
// therefore has to happen at read time, from a live file -- never baked.

// A line carrying a tag directive of any name: `// tag::foo[]`,
// `<!-- end::bar[] -->`, `# tag::baz[]`. Asciidoctor strips every such line from
// included content regardless of which tag is being selected, so a region never
// shows the markers of regions nested inside it.
const DIRECTIVE_LINE = /(?:^|[^\w:])(?:tag|end)::[^[\]]*\[\]/

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const markerFor = (kind, name) => new RegExp(`(?:^|[^\\w:])${kind}::${esc(name)}\\[\\]`)

// `lines=` value -> [ [from, to], … ], 1-indexed inclusive, `to === -1` meaning
// "to end of file". Asciidoctor accepts `;`- or `,`-separated ranges and bare
// single line numbers.
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

// A callout marker in source code is written as a line comment so the file still
// compiles: `foo(); // <1>`, or `// <1>` on its own line. Asciidoctor removes the
// comment marker and keeps the `<N>`, which is also the form the swizzled
// CodeBlock expects (it strips `<N>` and renders a badge). Whitespace before the
// comment marker is preserved, so the code column does not shift.
const normalizeCallouts = (line) =>
  line.replace(/(?:\/\/|#|--|;;) ?((?:<\d+> ?)*<\d+>)[ \t]*$/, '$1')

// `indent=0` on the LISTING BLOCK (`[source,java,indent=0]`, not on the include
// macro) tells Asciidoctor to reindent the block so its least-indented line
// starts at column 0. Three Platform blocks use it. Blank lines do not count
// towards the common indent.
function dedent (lines) {
  let min = Infinity
  for (const l of lines) {
    if (!l.trim()) continue
    min = Math.min(min, l.length - l.replace(/^[ \t]+/, '').length)
  }
  if (!isFinite(min) || min === 0) return lines
  return lines.map((l) => (l.trim() ? l.slice(min) : l))
}

// Drop trailing blank lines and terminate with exactly one newline. Asciidoctor
// trims trailing whitespace lines off a listing block, and @docusaurus/
// theme-common's createCodeBlockMetadata strips exactly one trailing newline —
// so one is the value that renders with no stray blank last line, matching how a
// whole-file example (which ends in a newline) already renders.
function normalizeTail (lines) {
  const out = lines.slice()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.length ? out.join('\n') + '\n' : ''
}

// The shared tail of every selection path: strip directives, apply Asciidoctor's
// line normalization, optionally reindent, then terminate.
function finish (lines, selector) {
  // NB no trailing-whitespace strip: Asciidoctor preserves it inside a listing
  // block (verified against the golden), even though the MDX writer does not.
  let out = lines.filter((l) => !DIRECTIVE_LINE.test(l)).map(normalizeCallouts)
  if (selector && String(selector.indent) === '0') out = dedent(out)
  return normalizeTail(out)
}

// source: the raw file text. selector: { tag } | { lines } | null for the whole
// file. `where` names the file in error messages.
//
// Throws on a tag that is absent or unterminated: a typo, or an upstream rename
// of a region a page still asks for, must fail the build. Silently emitting an
// empty code block is the one outcome worse than a broken build, because it
// ships.
function sliceRegion (source, selector, where = 'example') {
  const lines = String(source).split('\n')
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
  // Lists and negation (`tags=a;!b`) are valid Asciidoctor but appear nowhere in
  // the corpus. Refuse them rather than mis-slice: a wrong region renders as
  // plausible-looking code, which no gate downstream can recognise as wrong.
  if (/[;,!*]/.test(name)) throw new Error(`${where}: tag list/negation is not supported (${JSON.stringify(name)})`)

  const startRe = markerFor('tag', name)
  const endRe = markerFor('end', name)
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) throw new Error(`${where}: no region tagged ${JSON.stringify(name)}`)
  const rel = lines.slice(start + 1).findIndex((l) => endRe.test(l))
  if (rel === -1) throw new Error(`${where}: region ${JSON.stringify(name)} is opened but never closed (no end::${name}[])`)

  return finish(lines.slice(start + 1, start + 1 + rel), selector)
}

// Every slice a file offers, as the converter's content index needs it: one
// entry per (selector, rendered content) pair, carrying the exact import query
// that reproduces it. Both the as-authored and the reindented form of each
// region are offered, because whether a block was dedented is a property of the
// PAGE (`[source,java,indent=0]`), not of the file — so the converter can only
// tell by which one the golden matches.
function allRegions (source) {
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
    // A region whose least-indented line is already at column 0 reindents to
    // itself; offering both forms would be two index entries for one string.
    if (!content || seen.has(content)) return
    seen.add(content)
    out.push({ selector, query, content })
  }
  // The unqueried entry is the RAW file, because that is what the loader emits
  // for an import with no query -- keep the index and the loader in agreement.
  if (String(source).trim()) { out.push({ selector: null, query: '', content: String(source) }); seen.add(String(source)) }
  add({ indent: '0' }, '?indent=0')
  for (const name of names) {
    add({ tag: name }, `?tag=${encodeURIComponent(name)}`)
    add({ tag: name, indent: '0' }, `?tag=${encodeURIComponent(name)}&indent=0`)
  }
  return out
}

module.exports = { sliceRegion, allRegions, parseLineRanges }
