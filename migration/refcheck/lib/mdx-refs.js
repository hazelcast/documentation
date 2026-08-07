'use strict'

// CONVERTED side of the no-baking check: locate a page's MDX in an output tree
// by the slug that preserves its Antora URL, gather all the text a reader of
// that page actually sees -- the page MDX plus every factored partial it imports
// (recursively) plus every co-located example file it imports -- and answer
// "does this page still carry a REFERENCE to attribute NAME?".
//
// A preserved reference takes one of the forms the converter emits:
//   - prose:  <Variable name="NAME"/>           (any Variable name= attr)
//   - link:   <Variable href="{NAME}" …/>       (NAME as a {…} token)
//   - code:   ```lang vars … {NAME} …```         (NAME as a {…} token)
//   - example: an imported byte-faithful file still containing {NAME}
// so a reference is present iff the gathered text has `name="NAME"` or an
// UNESCAPED `{NAME}` token.

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

// Import specifiers in an MDX file: partial (@site/…/_partials/….mdx) and
// example (relative …/examples/…) imports, resolved to absolute paths.
const IMPORT_RE = /^\s*import\s+\w+\s+from\s+'([^']+)'/gm
function importsOf (text, file, siteRoot) {
  const partials = []
  const examples = []
  let m
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1]
    if (spec.startsWith('@site/') && spec.includes('/_partials/') && spec.endsWith('.mdx')) {
      partials.push(path.join(siteRoot, spec.slice('@site/'.length)))
    } else if (/(^|\/)examples\//.test(spec) && (spec.startsWith('.') || spec.startsWith('@site/'))) {
      examples.push(spec.startsWith('@site/')
        ? path.join(siteRoot, spec.slice('@site/'.length))
        : path.resolve(path.dirname(file), spec))
    }
  }
  return { partials, examples }
}

// All the text a page renders: its own MDX + imported partials (recursively) +
// imported example files. `siteRoot` is the Docusaurus root (@site).
function reachableText (pageFile, siteRoot) {
  const seen = new Set()
  let text = ''
  const add = (file, isExample) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!fs.existsSync(file)) return
    const t = fs.readFileSync(file, 'utf8')
    text += '\n' + t
    if (isExample) return // example files carry no further imports we follow
    const { partials, examples } = importsOf(t, file, siteRoot)
    for (const p of partials) add(p, false)
    for (const ex of examples) add(ex, true)
  }
  add(pageFile, false)
  return text
}

// Does `text` carry a preserved reference to attribute NAME?
function hasRef (text, name) {
  const n = escRe(name)
  if (new RegExp(`\\bname="${n}"`).test(text)) return true // <Variable name="NAME"/>
  if (new RegExp(`(?<!\\\\)\\{${n}\\}`).test(text)) return true // {NAME} token, unescaped
  return false
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
    for (const ex of examples) out.add(ex)
    for (const p of partials) add(p)
  }
  add(pageFile)
  return out
}

module.exports = { indexOutput, reachableText, hasRef, exampleImports, importsOf, slugOf, urlToSlug }
