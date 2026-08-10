'use strict'

// Layer 3 calibration report (NOT a pass/fail test -- no assertions, always
// exits 0). Runs Layer 3 link/anchor resolution over the golden snapshot alone
// (no converted output needed) and prints a histogram of unresolved links by
// type, with samples. A human reads it to tune the resolver: every internal link
// in the golden should resolve to a known site URL and every "#frag" to a real
// anchor, so a surviving miss is either a resolver bug (fix it here) or a
// genuine pre-existing broken link production also serves (fidelity-neutral,
// belongs in the Layer 3 baseline). Run: node fidelity/layer3-report.js

const fs = require('node:fs')
const path = require('node:path')

const { goldenPages, readGolden } = require('./lib/pairing')
const { buildIndex } = require('./lib/manifest-index')
const { loadAnchorIndex } = require('./lib/anchor-index')
const { checkPage } = require('./lib/layer3')
const { lockfileKeyFromFile } = require('./lockfile-key')

const goldenDir = path.resolve('build/golden')
const manifest = JSON.parse(fs.readFileSync('build/manifest/manifest.json', 'utf8'))
const manifestIndex = buildIndex(manifest)
const siteHost = new URL(manifestIndex.siteUrl).host
const lfKey = lockfileKeyFromFile('build/manifest/lockfile.json')
const anchorIndex = loadAnchorIndex(goldenDir, lfKey, path.join(goldenDir, 'anchor-index.json'))

console.log('manifest url counts:', JSON.stringify(manifestIndex.counts), '| siteHost:', siteHost)
console.log('anchor index pages:', anchorIndex.size)

const byType = new Map()
const samples = new Map()
let pagesWithProblems = 0
let totalLinks = 0
const pages = goldenPages(goldenDir)
for (const p of pages) {
  const html = readGolden(p.file)
  const problems = checkPage({ html, pageUrl: p.url, fragment: true }, { manifestIndex, anchorIndex, siteHost })
  totalLinks += (html.match(/<a\s[^>]*href=/gi) || []).length
  if (problems.length) pagesWithProblems++
  for (const pr of problems) {
    byType.set(pr.type, (byType.get(pr.type) || 0) + 1)
    if (!samples.has(pr.type)) samples.set(pr.type, [])
    const arr = samples.get(pr.type)
    if (arr.length < 12) arr.push({ page: p.url, ...pr })
  }
}

console.log(`\nscanned ${pages.length} pages, ~${totalLinks} links; ${pagesWithProblems} pages with problems`)
console.log('problems by type:')
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${t}`)
console.log('\nsamples:')
for (const [t, arr] of samples) {
  console.log(`\n[${t}]`)
  for (const s of arr) console.log('  ', JSON.stringify(s))
}
