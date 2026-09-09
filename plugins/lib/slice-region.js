'use strict'

// The ONE implementation of Antora/Asciidoctor `include::…[tag=…]` region
// slicing. Shared by the build-time tag-slice webpack loader
// (plugins/example-attributes/tag-slice-loader.js) and, during the migration,
// by the converter's content-addressed example index -- the same arrangement
// as substitute-attributes.js, so the two cannot drift and disagree about what
// a given slice contains.
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

// Asciidoctor drops a leading UTF-8 BOM when it reads an included file, so the
// rendered block never shows one. Our staged copies keep it -- deliberately: the
// build verifies the fetched bytes against a hash of the file as it exists
// upstream, and stripping it there would make every hash mismatch. So it comes off
// HERE instead, at the one point the converter's index and the build-time loader
// both pass through, which is what keeps them agreeing with each other AND with
// Antora. Eight C# examples across the guide repos and code-samples start with one;
// until this, every one of them failed to content-match and baked.
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s)

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
  // Wildcards (`*`, `**`) select by pattern rather than by name and appear nowhere
  // in the corpus. Refuse them rather than mis-slice: a wrong region renders as
  // plausible-looking code, which no gate downstream can recognise as wrong.
  if (/\*/.test(name)) throw new Error(`${where}: tag wildcards are not supported (${JSON.stringify(name)})`)
  // Lists and negation DO occur -- `tags=hazelcast-hibernate;hazelcast-dep` and
  // `tags=!intro-comments`, one guide each. They used to be refused here on the
  // stated grounds that the corpus had none, which was simply untrue; the effect
  // was that both blocks baked.
  if (/[;,!]/.test(name)) return finish(selectTagSet(lines, name, where), selector)

  const startRe = markerFor('tag', name)
  const endRe = markerFor('end', name)
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) throw new Error(`${where}: no region tagged ${JSON.stringify(name)}`)
  const rel = lines.slice(start + 1).findIndex((l) => endRe.test(l))
  if (rel === -1) throw new Error(`${where}: region ${JSON.stringify(name)} is opened but never closed (no end::${name}[])`)

  return finish(lines.slice(start + 1, start + 1 + rel), selector)
}

// Select the lines a multi-tag spec asks for: `a;b` is the union of those regions,
// `!a` is everything OUTSIDE that region, and the two combine (`a;!b` = region a
// minus region b). Region membership is tracked as a SET, because tags nest and a
// line can sit inside several at once.
//
// As strict as the single-tag path about names: a tag that is absent or never
// closed is a typo or an upstream rename, and must fail the build rather than
// quietly select the wrong lines.
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
    // No positive term means "everything not excluded" -- a pure-negation spec.
    if (!positive.length || positive.some((t) => active.has(t))) picked.push(line)
  }
  return picked
}

// Every slice a file offers, as the converter's content index needs it: one
// entry per (selector, rendered content) pair, carrying the exact import query
// that reproduces it. Both the as-authored and the reindented form of each
// region are offered, because whether a block was dedented is a property of the
// PAGE (`[source,java,indent=0]`), not of the file — so the converter can only
// tell by which one the golden matches.
// Query-encode a selector for an import request. encodeURIComponent is not enough:
// it leaves `!` alone, and webpack reads `!` in a request as the inline-loader
// separator -- `Foo.java?tags=!intro` is parsed as "apply loader Foo.java?tags= to
// module intro" and fails to resolve. URLSearchParams percent-decodes it back in
// the loader, so the two stay in step.
const encodeSelector = (s) => encodeURIComponent(s).replace(/!/g, '%21')

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
    // A region whose least-indented line is already at column 0 reindents to
    // itself; offering both forms would be two index entries for one string.
    if (!content || seen.has(content)) return
    seen.add(content)
    out.push({ selector, query, content })
  }
  // The unqueried entry is the RAW file, because that is what the loader emits
  // for an import with no query -- keep the index and the loader in agreement.
  const raw = stripBom(String(source))
  if (raw.trim()) { out.push({ selector: null, query: '', content: raw }); seen.add(raw) }
  add({ indent: '0' }, '?indent=0')
  for (const name of names) {
    add({ tag: name }, `?tag=${encodeSelector(name)}`)
    add({ tag: name, indent: '0' }, `?tag=${encodeSelector(name)}&indent=0`)
  }
  // Selectors a caller knows are asked for but that cannot be enumerated from the
  // file alone -- tag lists and negations. `add` swallows the throw for a spec
  // naming a region this file does not have, which is the normal case: the specs
  // come from the whole component, and only one file answers each.
  for (const spec of extraSelectors) {
    add({ tag: spec }, `?tags=${encodeSelector(spec)}`)
    add({ tag: spec, indent: '0' }, `?tags=${encodeSelector(spec)}&indent=0`)
  }
  return out
}

module.exports = { sliceRegion, allRegions, parseLineRanges, stripBom }
