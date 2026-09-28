'use strict'

// Layer 3 baseline: the set of link/anchor problems already present in the
// GOLDEN pages -- i.e. links production itself serves broken (verified against
// the live site: unresolved .adoc xrefs, section-anchor typos, PascalCase
// api-ref anchors, intentional <placeholder> URLs). These are fidelity-neutral:
// they exist identically in golden and will exist identically in a faithful
// conversion, so the runner must SUBTRACT them and report only NEW breakage the
// converter introduces. Built from golden once, cached keyed to the lockfile.

const fs = require('node:fs')
const path = require('node:path')

const { goldenPages, readGolden } = require('./pairing')
const { checkPage } = require('./layer3')

// Stable identity of a problem within a page, so a golden problem and the same
// problem on the converted page compare equal.
function problemKey (pr) {
  switch (pr.type) {
    case 'dead-link': return `dead-link|${pr.path}`
    case 'dead-anchor-self': return `dead-anchor-self|${pr.anchor}`
    case 'dead-anchor-cross': return `dead-anchor-cross|${pr.path}|${pr.anchor}`
    case 'dropped-anchor-cross': return `dropped-anchor-cross|${pr.path}|${pr.anchor}`
    case 'malformed-href': return `malformed-href|${pr.href}`
    default: return `${pr.type}|${JSON.stringify(pr)}`
  }
}

function buildBaseline (goldenDir, deps) {
  const byPage = new Map()
  for (const p of goldenPages(goldenDir)) {
    const html = readGolden(p.file)
    const problems = checkPage({ html, pageUrl: p.url, fragment: true }, deps)
    if (problems.length) byPage.set(p.url, new Set(problems.map(problemKey)))
  }
  return byPage
}

function loadBaseline (goldenDir, deps, lockfileKey, cacheFile) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (cached.lockfileKey === lockfileKey) {
        return new Map(Object.entries(cached.byPage).map(([u, keys]) => [u, new Set(keys)]))
      }
    } catch { /* rebuild */ }
  }
  const byPage = buildBaseline(goldenDir, deps)
  if (cacheFile) {
    const serial = Object.fromEntries([...byPage].map(([u, s]) => [u, [...s]]))
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ lockfileKey, byPage: serial }))
  }
  return byPage
}

// Given a converted page's problems, drop the ones already known-broken in
// golden for that page URL; the remainder are NEW (converter-introduced).
function novelProblems (pageUrl, problems, baseline) {
  const known = baseline.get(pageUrl) || new Set()
  return problems.filter((pr) => !known.has(problemKey(pr)))
}

module.exports = { problemKey, buildBaseline, loadBaseline, novelProblems }
