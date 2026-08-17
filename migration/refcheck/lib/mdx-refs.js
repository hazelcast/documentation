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
//                   plugins/example-attributes-loader.js)
// so a page's count is `name="NAME"` occurrences plus unescaped `{NAME}` tokens --
// with `{NAME}` inside a fence that does NOT carry the `vars` flag excluded,
// because Docusaurus renders such a fence literally and the converter only writes
// a token into a fence it also marks `vars`.

const fs = require('node:fs')
const path = require('node:path')

const { urlToSlug } = require('../../lib/layout')

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
      examples.push({
        id,
        file: spec.startsWith('@site/')
          ? path.join(siteRoot, spec.slice('@site/'.length))
          : path.resolve(path.dirname(file), spec),
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

// References to NAME in one MDX file's own body (imports and literal fences
// already removed).
function countMdxRefs (body, name) {
  const n = escRe(name)
  return countMatches(body, new RegExp(`\\bname="${n}"`, 'g')) +
    countMatches(body, new RegExp(`(?<!\\\\)\\{${n}\\}`, 'g'))
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
// Returns Map(name -> count).
function refCounts (pageFile, siteRoot, names) {
  const counts = new Map(names.map((n) => [n, 0]))
  const bump = (name, n) => counts.set(name, (counts.get(name) || 0) + n)

  const visit = (file, multiplier, kind, stack) => {
    if (multiplier <= 0 || stack.has(file) || !fs.existsSync(file)) return
    const text = fs.readFileSync(file, 'utf8')
    if (kind === 'example') {
      for (const name of names) {
        const c = countExampleRefs(text, name)
        if (c) bump(name, c * multiplier)
      }
      return // raw file: no imports to follow
    }
    const body = dropLiteralFences(stripImports(stripFrontmatter(text)))
    for (const name of names) {
      const c = countMdxRefs(body, name)
      if (c) bump(name, c * multiplier)
    }
    const { partials, examples } = importsOf(text, file, siteRoot)
    const next = new Set([...stack, file])
    for (const p of partials) visit(p.file, multiplier * usageCount(body, p.id, 'partial'), 'partial', next)
    for (const e of examples) visit(e.file, multiplier * usageCount(body, e.id, 'example'), 'example', next)
  }

  visit(pageFile, 1, 'page', new Set())
  return counts
}

// The example imports a page reaches (absolute paths), for the
// example-preservation check.
function exampleImports (pageFile, siteRoot) {
  const seen = new Set()
  const out = new Set()
  const add = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return
    seen.add(file)
    const { partials, examples } = importsOf(fs.readFileSync(file, 'utf8'), file, siteRoot)
    for (const ex of examples) out.add(ex.file)
    for (const p of partials) add(p.file)
  }
  add(pageFile)
  return out
}

module.exports = {
  indexOutput, refCounts, exampleImports, importsOf, slugOf, urlToSlug,
  countMdxRefs, countExampleRefs, usageCount, dropLiteralFences, stripImports,
  stripFrontmatter, frontmatterTokens,
}
