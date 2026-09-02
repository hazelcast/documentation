'use strict'

// CONVERTED side of the no-baking check: how many references to attribute NAME
// does a converted page actually carry?
//
// Counts, not presence. The old checker asked a yes/no question per page, which
// meant five source occurrences with four baked and one surviving passed the
// gate. The census gives an exact expected count per page, so this side has to be
// exact too -- including MULTIPLICITY: a partial contributes its references once
// per USE, because that is what the golden shows (Antora inlines the partial at
// each include site, Docusaurus renders the component at each usage site).
//
// A reference takes one of the forms the converter emits:
//   prose/heading:  <Variable name="NAME"/>
//   link:           <Variable href="{NAME}" text="{NAME} console"/>
//   code:           ```shell vars … {NAME} …```
//   example:        {NAME} in an imported example file (substituted at build by
//                   plugins/example-attributes/attributes-loader.js)
// so a page's count is `name="NAME"` occurrences plus unescaped `{NAME}` tokens --
// with `{NAME}` inside a fence that does NOT carry the `vars` flag excluded,
// because Docusaurus renders such a fence literally and the converter only writes
// a token into a fence it also marks `vars`.

const fs = require('node:fs')
const path = require('node:path')

const { urlToSlug } = require('../../lib/layout')
// The ONE slicer, shared with the converter and the build-time loader.
const { sliceRegion } = require('../../../plugins/lib/slice-region')

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Frontmatter `slug:` of an MDX file, or null. Slugs are emitted unquoted.
function slugOf (text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return null
  const m = fm[1].match(/^slug:\s*(.+?)\s*$/m)
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

// Index one output tree: slug -> absolute .mdx path (top-level pages only;
// _partials are resolved by import path, not slug). Skips co-located asset dirs.
function indexOutput (outDir) {
  const bySlug = new Map()
  if (!fs.existsSync(outDir)) return bySlug
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === '_partials' || e.name === 'images' || e.name === 'examples') continue
        walk(path.join(dir, e.name))
        continue
      }
      if (!e.name.endsWith('.mdx')) continue
      const p = path.join(dir, e.name)
      const slug = slugOf(fs.readFileSync(p, 'utf8'))
      if (slug) bySlug.set(slug, p)
    }
  }
  walk(outDir)
  return bySlug
}

// Import specifiers in an MDX file, with the local identifier each is bound to
// (needed to count USES): partial (@site/…/_partials/….mdx) and example
// (relative or @site …/examples/…) imports, resolved to absolute paths.
const IMPORT_RE = /^\s*import\s+(\w+)\s+from\s+'([^']+)'/gm
function importsOf (text, file, siteRoot) {
  const partials = []
  const examples = []
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const [, id, spec] = m
    if (spec.startsWith('@site/') && spec.includes('/_partials/') && spec.endsWith('.mdx')) {
      partials.push({ id, file: path.join(siteRoot, spec.slice('@site/'.length)) })
    } else if (/(^|\/)examples\//.test(spec) && (spec.startsWith('.') || spec.startsWith('@site/'))) {
      // An example import may carry a region selector (`?tag=…`, `?lines=…`,
      // `&indent=0`), read at build by the tag-slice loader. Split it off
      // the path — what the page renders is that SLICE, not the whole file.
      const q = spec.indexOf('?')
      const bare = q === -1 ? spec : spec.slice(0, q)
      examples.push({
        id,
        query: q === -1 ? '' : spec.slice(q),
        file: bare.startsWith('@site/')
          ? path.join(siteRoot, bare.slice('@site/'.length))
          : path.resolve(path.dirname(file), bare),
      })
    }
  }
  return { partials, examples }
}

const stripImports = (text) => text.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')

// Frontmatter is YAML, not MDX: Docusaurus does not interpolate it, so a `{name}`
// there is NOT a reference -- it renders as literal braces (in a sidebar label,
// say). Split out rather than counted, so it is reported as the defect it is
// instead of inflating the page's reference count.
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/
const stripFrontmatter = (text) => text.replace(FRONTMATTER_RE, '')
function frontmatterTokens (text, names) {
  const m = text.match(FRONTMATTER_RE)
  const out = new Map()
  if (!m) return out
  for (const name of names) {
    const c = countMatches(m[0], new RegExp(`(?<!\\\\)\\{${escRe(name)}\\}`, 'g'))
    if (c) out.set(name, c)
  }
  return out
}

// Blank out the contents of every fenced code block that does NOT carry the
// `vars` flag, so a literal `{name}` in a plain fence is not miscounted as a
// reference. A `vars` fence keeps its body: those tokens ARE resolved at render
// by the swizzled CodeBlock.
function dropLiteralFences (text) {
  const lines = text.split('\n')
  const out = []
  let fence = null // { marker, vars }
  for (const line of lines) {
    const open = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (open && open[1].startsWith(fence.marker) && open[2].trim() === '') { fence = null; out.push(line); continue }
      out.push(fence.vars ? line : '')
      continue
    }
    if (open) { fence = { marker: open[1], vars: /(^|\s)vars(\s|$)/.test(open[2]) }; out.push(line); continue }
    out.push(line)
  }
  return out.join('\n')
}

const countMatches = (text, re) => (text.match(re) || []).length

// Drop the content of a conditional branch this version does not render.
//
// The converter emits BOTH halves of a `snapshot` conditional into every version's
// MDX -- the half this version resolved, and the other spliced in from a version
// that did (converter/convert.js withBothConditionalBranches) -- so a
// `docusaurus docs:version` cut carries both and <IfSnapshot>/<IfNotSnapshot>
// choose at build time. Only one half reaches the reader, and the census (one
// version's render) only accounts for that half, so the hidden one must not be
// counted here. Which half is hidden comes from the census render itself -- see
// census-ledger.js hiddenBranchComponents.
//
// Line-based on the components' own lines, which is how the converter writes them
// (padded, and indented to their surroundings when spliced into a list item or a
// <TabItem>). Nothing else in the corpus nests these, so a flat scan is enough;
// an unclosed opener would swallow the rest of the file, so the closer is required
// and the region is kept if it never arrives.
function dropHiddenBranches (text, tags) {
  if (!tags || !tags.length || !tags.some((t) => text.includes(`<${t}>`))) return text
  const opener = new RegExp(`^\\s*<(${tags.map(escRe).join('|')})>\\s*$`)
  const out = []
  let dropping = null // { closer, buffered }
  for (const line of text.split('\n')) {
    if (dropping) {
      dropping.buffered.push(line)
      if (dropping.closer.test(line)) dropping = null
      continue
    }
    const m = line.match(opener)
    if (m) { dropping = { closer: new RegExp(`^\\s*</${escRe(m[1])}>\\s*$`), buffered: [line] }; continue }
    out.push(line)
  }
  // Unterminated: put it back rather than silently losing the tail of the page.
  if (dropping) out.push(...dropping.buffered)
  return out.join('\n')
}

// A reference the CENSUS CANNOT SEE, so this side must not count it either: an
// attribute used as an xref's VERSION COORDINATE
// (`xref:{page-latest-supported-hazelcast}@hazelcast:sql:create-index.adoc[…]`).
// Antora resolves those during classification, and the census has to substitute
// the real value into xref/include targets BEFORE poisoning or 1431 xrefs stop
// resolving (preResolveTargets) — so a coordinate never becomes a token and never
// enters `expected`. Counting the reference the converter emits for it therefore
// inflates `actual`, which showed up as a false OVER-variableised finding on MC's
// update-config once its two genuine URL references were fixed. The same
// asymmetry previously MASKED a bake on that page, reporting 2->1 when both URLs
// were baked and the survivor was the coordinate.
//
// Excluding on THIS side rather than adding to `expected` keeps the gate ignorant
// of converter behaviour. The converter does not always emit a reference for a
// coordinate: where the version equals the target component's current latest it
// floats the link to `/<comp>/latest/…` instead (MC@5.11, whose value 5.7 is
// hazelcast's latest). Both outcomes balance here — a floated link leaves no token
// to count, an emitted one is excluded — whereas an `expected`-side count would
// have to model the float rule to avoid a false bake.
//
// The shape is specific: a site-absolute cross-component path whose VERSION
// SEGMENT is the reference. An external URL that merely contains a reference
// (cloud's `https://docs.hazelcast.com/hazelcast/{page-cloud-platform-version}/…`)
// has a scheme and so does not match, and is correctly still counted.
const coordinateRefRe = (name) => new RegExp(`href="/[^/"]+/\\{${escRe(name)}\\}(?=[/"])`, 'g')
const dropCoordinateRefs = (body, name) => body.replace(coordinateRefRe(name), 'href="/')

// References to NAME in one MDX file's own body (imports and literal fences
// already removed).
function countMdxRefs (body, name) {
  const n = escRe(name)
  const counted = dropCoordinateRefs(body, name)
  return countMatches(counted, new RegExp(`\\bname="${n}"`, 'g')) +
    countMatches(counted, new RegExp(`(?<!\\\\)\\{${n}\\}`, 'g'))
}

// References to NAME in an imported example file: raw text, so only `{NAME}`.
function countExampleRefs (text, name) {
  return countMatches(text, new RegExp(`(?<!\\\\)\\{${escRe(name)}\\}`, 'g'))
}

// How many times an import's identifier is USED in a body: a partial as the JSX
// component `<PartialFoo/>`, an example as the expression `{Ex_foo}`.
function usageCount (body, id, kind) {
  return kind === 'partial'
    ? countMatches(body, new RegExp(`<${escRe(id)}(?![A-Za-z0-9_])`, 'g'))
    : countMatches(body, new RegExp(`\\{\\s*${escRe(id)}\\s*\\}`, 'g'))
}

// Total references to each of `names` that a converted page renders: its own body
// plus every imported partial and example file, each counted once per use.
// `hiddenBranches` names the conditional-branch components this version does not
// render, whose content is present in the MDX but shown to nobody here.
// Returns Map(name -> count).
function refCounts (pageFile, siteRoot, names, { hiddenBranches = [] } = {}) {
  const counts = new Map(names.map((n) => [n, 0]))
  const bump = (name, n) => counts.set(name, (counts.get(name) || 0) + n)

  const visit = (file, multiplier, kind, stack, query) => {
    if (multiplier <= 0 || stack.has(file + (query || '')) || !fs.existsSync(file)) return
    let text = fs.readFileSync(file, 'utf8')
    if (kind === 'example') {
      // Count against the SLICE the page shows, not the whole file: a tag region
      // may carry no {attribute} while another region of the same file does.
      text = sliceForQuery(text, query, file)
      for (const name of names) {
        const c = countExampleRefs(text, name)
        if (c) bump(name, c * multiplier)
      }
      return // raw file: no imports to follow
    }
    const body = dropHiddenBranches(dropLiteralFences(stripImports(stripFrontmatter(text))), hiddenBranches)
    for (const name of names) {
      const c = countMdxRefs(body, name)
      if (c) bump(name, c * multiplier)
    }
    const { partials, examples } = importsOf(text, file, siteRoot)
    const next = new Set([...stack, file])
    for (const p of partials) visit(p.file, multiplier * usageCount(body, p.id, 'partial'), 'partial', next)
    for (const e of examples) visit(e.file, multiplier * usageCount(body, e.id, 'example'), 'example', next, e.query)
  }

  visit(pageFile, 1, 'page', new Set())
  return counts
}

// The example imports a page reaches (absolute paths), for the
// example-preservation check.
// Resolve an example import's query through the SHARED slicer -- the same module
// the build-time loader uses -- so the gate reads exactly the text the site will
// render. An unresolvable selector falls back to the whole file rather than
// throwing: a broken region is the build's error to report, not this gate's.
function sliceForQuery (text, query, where) {
  if (!query) return text
  const q = new URLSearchParams(query)
  const selector = {}
  const tag = q.get('tag') || q.get('tags')
  if (tag != null) selector.tag = tag
  if (q.get('lines') != null) selector.lines = q.get('lines')
  if (q.get('indent') != null) selector.indent = q.get('indent')
  try { return sliceRegion(text, selector, where) } catch { return text }
}

// The example SLICES a page imports (following partials), as
// `<path under examples/>` plus the region selector, and how many times each is
// USED in the body. The path is relative to the examples tree so it is directly
// comparable with the `example$/…` target a source page names.
function exampleImports (pageFile, siteRoot) {
  const seen = new Set()
  const out = new Map()
  const add = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    const body = stripImports(stripFrontmatter(text))
    const { partials, examples } = importsOf(text, file, siteRoot)
    for (const ex of examples) {
      const rel = exampleRel(ex.file)
      const prev = out.get(rel + ex.query) || { rel, query: ex.query, uses: 0 }
      prev.uses += usageCount(body, ex.id, 'example')
      out.set(rel + ex.query, prev)
    }
    for (const p of partials) add(p.file)
  }
  add(pageFile)
  return out
}

// `…/hazelcast/examples/cp/CpSubsystemAPI.java` -> `cp/CpSubsystemAPI.java`.
function exampleRel (file) {
  const parts = file.split(path.sep).join('/').split('/examples/')
  return parts.length > 1 ? parts[parts.length - 1] : file
}

module.exports = {
  indexOutput, refCounts, exampleImports, importsOf, slugOf, urlToSlug,
  countMdxRefs, countExampleRefs, usageCount, exampleRel, sliceForQuery, dropLiteralFences, dropHiddenBranches,
  stripImports, stripFrontmatter, frontmatterTokens,
}
