'use strict'

// Pairing: the map between the three representations of a single doc page.
//
//   golden HTML file            site URL              converted HTML file
//   build/golden/pages/         (manifest key,        <root>/build/ (Docusaurus
//   cloud/install.html    <-->  /cloud/install  <-->  static output)
//
// The site URL is the join key. The golden tree is authored by Antora's
// out.path, so URL derivation must match Antora's rules exactly (verified
// 100% against manifest.json in self-check below):
//   - drop the .html extension (html_extension_style: drop)
//   - an index page collapses to its directory URL with a trailing slash
//     (root index.adoc -> "/cloud/", "/hazelcast/5.0/")
// Everything else is "/" + path-without-.html, no trailing slash
// (trailingSlash: false).

const fs = require('node:fs')
const path = require('node:path')
const { stripSentinels } = require('../../antora-extension/mark-partials')
const { stripAttrSpans } = require('../../antora-extension/mark-attributes')
const { stripConditionalSentinels } = require('../../antora-extension/mark-conditionals')

function walkHtml (dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('.html')) out.push(p)
    }
  }
  return out
}

// A golden file's path relative to the pages root -> its site URL.
function urlFromGoldenRel (rel) {
  const clean = rel.split(path.sep).join('/').replace(/\.html$/, '')
  if (clean === 'index') return '/'
  if (clean.endsWith('/index')) return '/' + clean.slice(0, -'index'.length) // keep trailing slash
  return '/' + clean
}

// Discover every golden page under <goldenDir>/pages, returning the join key
// (url) plus enough provenance to scope by component/version and to locate the
// converted counterpart. component/version are the leading path segments, which
// is all scoping needs; the URL is the authoritative identity.
function goldenPages (goldenDir) {
  const pagesRoot = path.join(goldenDir, 'pages')
  return walkHtml(pagesRoot).map((file) => {
    const rel = path.relative(pagesRoot, file)
    const segs = rel.split(path.sep)
    return {
      file,
      rel: segs.join('/'),
      url: urlFromGoldenRel(rel),
      component: segs[0],
      // segs[1] is the version for versioned components and the first content
      // segment for unversioned ones; callers that care resolve it via the
      // manifest rather than trusting this.
      versionSeg: segs.length > 1 ? segs[1] : '',
    }
  })
}

// Candidate paths for a URL in a Docusaurus static build. trailingSlash: false
// emits "/cloud/install" as build/cloud/install.html, and a directory URL
// "/cloud/" as build/cloud/index.html. We return both plausible forms and let
// the caller pick whichever exists, so we are not brittle to a trailingSlash
// config change.
function convertedCandidates (buildDir, url) {
  const trimmed = url.replace(/^\//, '')
  const candidates = []
  if (url.endsWith('/')) {
    candidates.push(path.join(buildDir, trimmed, 'index.html'))
  } else {
    candidates.push(path.join(buildDir, trimmed + '.html'))
    candidates.push(path.join(buildDir, trimmed, 'index.html'))
  }
  return candidates
}

function resolveConverted (buildDir, url) {
  for (const c of convertedCandidates(buildDir, url)) {
    if (fs.existsSync(c)) return c
  }
  return null
}

// Single ingestion point for golden HTML. Strips the instrumentation the golden
// may carry -- partial-boundary sentinels (mark-partials.js) and attribute-
// reference marker spans (mark-attributes.js) -- so the harness compares the
// de-instrumented render regardless of how the golden was built. Both strips
// reproduce the un-instrumented render byte-for-byte, so an instrumented golden
// is indistinguishable from a plain one at compare time. Every golden read in
// the fidelity code MUST go through this.
function readGolden (file) {
  return stripConditionalSentinels(stripAttrSpans(stripSentinels(fs.readFileSync(file, 'utf8'))))
}

module.exports = { walkHtml, urlFromGoldenRel, goldenPages, convertedCandidates, resolveConverted, readGolden }
