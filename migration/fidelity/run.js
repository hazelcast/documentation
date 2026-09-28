'use strict'

// The fidelity runner: compares each CONVERTED Docusaurus page against its
// GOLDEN Antora counterpart across all three layers, and reports only
// regressions the conversion introduced. Local, on-demand (no CI yet, per
// [[docusaurus-migration-git-strategy]]). Run:
//
//   node fidelity/run.js [--component X] [--id /url] [--layer 1,2,3]
//                        [--build-dir ../build] [--golden build/golden]
//                        [--manifest build/manifest] [--json] [--strict]
//
// --strict adds the cutover completeness check: every page of the live set
// (lib/live-set.js) must have a golden AND a converted page, and the snapshot
// must be the full corpus. Without it a missing page is only counted, because
// mid-migration most of the corpus is legitimately not converted yet.
//
// Reads three things: the golden snapshot (the "before"), the manifest/lockfile
// (the pin + link table), and the root Docusaurus static build (the "after",
// produced by `npm run build` at the repo root). It renders NOTHING itself.
//
// Hard stop: if the snapshot's pin no longer matches the current lockfile, the
// "before" is stale and every diff would be against the wrong baseline -- abort
// and name the regenerate command rather than comparing.

const fs = require('node:fs')
const path = require('node:path')

const { goldenPages, resolveConverted, readGolden } = require('./lib/pairing')
const { buildIndex } = require('./lib/manifest-index')
const { loadDispositions, unpublishedUrls } = require('../lib/dispositions')
const { isSitePage } = require('../lib/layout')
const { expectedPages, renderId } = require('../lib/live-set')
const { loadAccepted } = require('../lib/accepted')
const { loadAnchorIndex, convertedAnchorLookup } = require('./lib/anchor-index')
const { loadInventoryIndex } = require('./lib/inventory-index')
const { loadBaseline, novelProblems } = require('./lib/baseline')
const { checkPage } = require('./lib/layer3')
const { inventory, ASCIIDOC_PROFILE, DOCUSAURUS_PROFILE } = require('./lib/structure')
const { compareInventory, compareTitle, compareLinkTargets } = require('./lib/layer2')
const { linkTargets, linkDeps } = require('./lib/link-targets')
const { canonicalize, diffSegments, GOLDEN_STRIP, DOCUSAURUS_STRIP, DOCUSAURUS_STRIP_IF, GOLDEN_TABLE, DOCUSAURUS_TABLE } = require('./lib/layer1')
const { extractPage } = require('./lib/extract-main')
const { lockfileKeyFromFile } = require('./lockfile-key')

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  const layers = val('--layer', '1,2,3').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    component: val('--component', null),
    id: val('--id', null),
    layers: new Set(layers),
    goldenDir: path.resolve(val('--golden', 'build/golden')),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    buildDir: path.resolve(val('--build-dir', '../build')),
    json: has('--json'),
    strict: has('--strict'),
  }
}

function main () {
  const opts = parseArgs(process.argv)

  // --- pin hard-stop -------------------------------------------------------
  const metaFile = path.join(opts.goldenDir, 'snapshot-meta.json')
  if (!fs.existsSync(metaFile)) {
    console.error(`[fidelity] no golden snapshot at ${opts.goldenDir} -- run \`npm run fidelity:snapshot\` first.`)
    process.exit(2)
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  const lockfileFile = path.join(opts.manifestDir, 'lockfile.json')
  const currentKey = lockfileKeyFromFile(lockfileFile)
  if (meta.lockfileKey !== currentKey) {
    console.error(
      '[fidelity] ABORT: the golden snapshot was built from a different pin than the current lockfile.\n' +
      `           snapshot: ${meta.lockfileKey.slice(0, 12)}   lockfile: ${currentKey.slice(0, 12)}\n` +
      '           Regenerate the baseline: `npm run fidelity:snapshot` (then re-run).')
    process.exit(2)
  }
  if (meta.component) {
    console.warn(`[fidelity] NOTE: golden snapshot is SCOPED to component=${meta.component} (a smoke snapshot, not the full corpus).`)
  }

  // --- shared indexes (all lockfile-keyed caches under build/golden) -------
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))
  const manifestIndex = buildIndex(manifest)
  const siteHost = new URL(manifestIndex.siteUrl).host
  const anchorIndex = loadAnchorIndex(opts.goldenDir, currentKey, path.join(opts.goldenDir, 'anchor-index.json'))
  const inventoryIndex = loadInventoryIndex(opts.goldenDir, currentKey, path.join(opts.goldenDir, 'inventory-index.json'))
  const l3deps = { manifestIndex, anchorIndex, siteHost }
  // The baseline is golden-only, so it gets the deps WITHOUT the converted
  // anchors: a dropped anchor must never be subtracted away as pre-existing.
  const baseline = loadBaseline(opts.goldenDir, l3deps, currentKey, path.join(opts.goldenDir, 'layer3-baseline.json'))
  const pageL3deps = { ...l3deps, convertedAnchors: convertedAnchorLookup(opts.buildDir) }
  const titles = new Map(manifest.resources.filter((r) => r.family === 'page').map((r) => [r.url, r.title]))

  // --- scope ---------------------------------------------------------------
  const allGolden = goldenPages(opts.goldenDir)
  let pages = allGolden
  // A page an orphan triage decision does not publish (drop-404 or redirect) is
  // deliberately not converted, so it is out of scope rather than "not yet
  // converted" -- counting it as pending would overstate the work still left to
  // do, and it can never go green.
  const dispositions = loadDispositions()
  const targetDeps = linkDeps(manifest, dispositions)
  const unpublished = unpublishedUrls(dispositions, manifest)
  pages = pages.filter((p) => !unpublished.has(p.url))
  // A SITE PAGE is a hand-written React component that owns its URL outright
  // (src/pages/tutorials.tsx replaces the Antora tutorials landing page). The
  // converter already skips these -- isSitePage, converter/convert.js -- and there
  // is nothing here to compare: the golden is the page we deliberately replaced, so
  // every line of the replacement reads as a regression. Out of scope, not
  // accepted: an accept entry is for a difference we understand and still want to
  // watch, and a whole page of them would drown the list while telling us nothing.
  // Counted and reported, so narrowing the scope stays visible.
  const siteOwned = pages.filter((p) => isSitePage(p.url)).length
  pages = pages.filter((p) => !isSitePage(p.url))
  if (opts.component) pages = pages.filter((p) => p.component === opts.component)
  if (opts.id) pages = pages.filter((p) => p.url === opts.id)

  const completeness = opts.strict ? checkCompleteness(opts, meta, manifest, dispositions, allGolden) : null

  // --- per-page comparison -------------------------------------------------
  const { accept, errors: acceptErrors } = loadAccepted(path.join(__dirname, 'accepted.json'))
  const acceptedDiffs = []
  const matchedKeys = new Set()

  const report = []
  let converted = 0
  let pending = 0
  let regressed = 0
  for (const p of pages) {
    const convertedFile = resolveConverted(opts.buildDir, p.url)
    if (!convertedFile) { pending++; continue }
    converted++
    const fullHtml = fs.readFileSync(convertedFile, 'utf8')
    const { fragment, title } = extractPage(fullHtml)
    const entry = { url: p.url, l1: [], l2: [], l3: [] }
    if (fragment == null) {
      entry.error = 'no main-content container found'
      report.push(entry); regressed++; continue
    }
    const goldenHtml = readGolden(p.file)

    if (opts.layers.has('1')) {
      const g = canonicalize(goldenHtml, { stripSelectors: GOLDEN_STRIP, tableSelector: GOLDEN_TABLE })
      const c = canonicalize(fragment, { stripSelectors: DOCUSAURUS_STRIP, stripIf: DOCUSAURUS_STRIP_IF, tableSelector: DOCUSAURUS_TABLE })
      entry.l1 = diffSegments(g, c)
    }
    if (opts.layers.has('2')) {
      const g = inventoryIndex.get(p.url) || inventory(goldenHtml, ASCIIDOC_PROFILE)
      const c = inventory(fragment, DOCUSAURUS_PROFILE)
      entry.l2 = [
        ...compareTitle(titles.get(p.url), title),
        ...compareInventory(g, c),
        ...compareLinkTargets(linkTargets(goldenHtml, p.url, targetDeps), linkTargets(fragment, p.url, targetDeps)),
      ]
    }
    if (opts.layers.has('3')) {
      const problems = checkPage({ html: fragment, pageUrl: p.url, fragment: true }, pageL3deps)
      entry.l3 = novelProblems(p.url, problems, baseline)
    }
    // Accepted diffs (fidelity/accepted.json): understood, still reported, not
    // blocking. Applied per DIFF, not per page, so a page with one accepted diff
    // still fails on a new one. A page-level `error` is never acceptable -- there
    // is no diff to judge, so accepting it would mute the page entirely.
    for (const d of diffsOf(entry)) {
      const key = acceptKey(p.url, d)
      const e = Object.prototype.hasOwnProperty.call(accept, key) ? accept[key] : null
      if (e) { matchedKeys.add(key); acceptedDiffs.push({ key, entry: e, url: p.url }); d.accepted = true }
    }
    entry.l1 = entry.l1.filter((d) => !d.accepted)
    entry.l2 = entry.l2.filter((d) => !d.accepted)
    entry.l3 = entry.l3.filter((d) => !d.accepted)

    if (entry.l1.length || entry.l2.length || entry.l3.length) { regressed++; report.push(entry) }
  }

  // Only judge staleness for entries this run could have matched.
  const stale = Object.keys(accept)
    .filter((k) => !matchedKeys.has(k) &&
      (!opts.component || k.includes(` /${opts.component}/`)) &&
      (!opts.id || k.includes(` ${opts.id} `)))
    .sort()

  writeReport(opts, meta, { total: pages.length, converted, pending, regressed, siteOwned },
    report, { accepted: acceptedDiffs, stale, acceptErrors }, completeness)
  process.exit(regressed > 0 || stale.length > 0 || acceptErrors.length > 0 ||
    (completeness && !completeness.ok) ? 1 : 0)
}

// Strict mode: judged against the live set from the manifest, not the golden, so
// a page that failed to render (absent from the golden, listed in
// snapshot-errors.json) is a failure rather than invisible.
function checkCompleteness (opts, meta, manifest, dispositions, allGolden) {
  let expected = expectedPages(manifest, dispositions)
  if (opts.component) expected = expected.filter((r) => r.component === opts.component)
  if (opts.id) expected = expected.filter((r) => r.url === opts.id)

  const errorsFile = path.join(opts.goldenDir, 'snapshot-errors.json')
  const renderErrors = new Map(fs.existsSync(errorsFile)
    ? JSON.parse(fs.readFileSync(errorsFile, 'utf8')).map((e) => [e.id, e.message])
    : [])
  const goldenUrls = new Set(allGolden.map((p) => p.url))

  const missingGolden = []
  const notConverted = []
  for (const r of expected) {
    if (!goldenUrls.has(r.url)) missingGolden.push({ url: r.url, error: renderErrors.get(renderId(r)) || null })
    else if (!resolveConverted(opts.buildDir, r.url)) notConverted.push(r.url)
  }
  const scopedSnapshot = meta.component || null
  return {
    ok: !scopedSnapshot && !missingGolden.length && !notConverted.length,
    expected: expected.length, scopedSnapshot, missingGolden, notConverted,
  }
}

// One flat list of a page's diffs, tagged by layer, for accept-list matching.
// Tags in place (no copy) so marking a diff accepted is visible in entry.l1/l2/l3.
const diffsOf = (entry) => [
  ...entry.l1.map((d) => { d.layer = 'L1'; return d }),
  ...entry.l2.map((d) => { d.layer = 'L2'; return d }),
  ...entry.l3.map((d) => { d.layer = 'L3'; return d }),
]

// The accept-list key for ONE diff: exact, so accepting a missing line does not
// accept a different missing line on the same page. Printed by the gate so an
// entry can be copied straight from its output.
function acceptKey (url, d) {
  if (d.layer === 'L2') return `fidelity:L2: ${url} ${d.field} golden=${d.golden} converted=${d.converted}`
  if (d.layer === 'L3') return `fidelity:L3: ${url} ${d.type} ${d.path || ''}${d.anchor ? '#' + d.anchor : ''}`
  return `fidelity:L1: ${url} ${d.op} ${JSON.stringify(d.text)}`
}

function writeReport (opts, meta, counts, report, acceptance, completeness) {
  const outDir = path.resolve('build/diff')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'fidelity-report.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      scope: { component: opts.component, id: opts.id, layers: [...opts.layers] },
      counts,
      report,
      // The record of what is known-different has to be readable without re-running.
      accepted: acceptance.accepted.map((a) => ({ key: a.key, url: a.url, ...a.entry })),
      staleAcceptedKeys: acceptance.stale,
      acceptErrors: acceptance.acceptErrors,
      completeness,
    }, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify({ counts, report, ...acceptance, completeness })); return }

  const scope = opts.id ? `id=${opts.id}` : opts.component ? `component=${opts.component}` : 'all components'
  console.log(`\n[fidelity] ${scope}  layers=${[...opts.layers].join(',')}  pin ${meta.lockfileKey.slice(0, 12)} OK`)
  console.log(`[fidelity] golden pages in scope: ${counts.total} | converted found: ${counts.converted} | not yet converted: ${counts.pending}` +
    (counts.siteOwned ? ` | ${counts.siteOwned} site page(s) excluded (a hand-written component owns the URL)` : ''))
  if (completeness) printCompleteness(completeness)
  if (counts.converted === 0) {
    console.log('[fidelity] nothing converted in scope yet -- harness is ready; convert pages then re-run.')
    return
  }
  for (const e of report) {
    const tag = e.error ? `ERROR: ${e.error}` : `L1:${e.l1.length} L2:${e.l2.length} L3:${e.l3.length}`
    console.log(`\n  ✗ ${e.url}  [${tag}]`)
    for (const op of e.l1.slice(0, 20)) console.log(`      L1 ${op.op} ${op.kind === 'code' ? '{code}' : ''} ${JSON.stringify(op.text.slice(0, 100))}`)
    if (e.l1.length > 20) console.log(`      L1 ... +${e.l1.length - 20} more`)
    for (const d of e.l2) console.log(`      L2 ${d.field}: golden=${d.golden} converted=${d.converted}`)
    for (const pr of e.l3) console.log(`      L3 ${pr.type} ${pr.path || ''}${pr.anchor ? '#' + pr.anchor : ''}`)
  }
  // Accepted diffs: printed EVERY run, deliberately. The accept-list stops them
  // blocking; it is not there to make them invisible.
  if (acceptance.accepted.length) {
    const byUrl = new Map()
    for (const a of acceptance.accepted) {
      if (!byUrl.has(a.url)) byUrl.set(a.url, [])
      byUrl.get(a.url).push(a)
    }
    console.log(`\n[fidelity] ${acceptance.accepted.length} accepted difference(s) on ${byUrl.size} page(s)` +
      ' — understood, not blocking (fidelity/accepted.json):')
    for (const [url, rows] of [...byUrl].sort()) {
      console.log(`\n  ~ ${url}`)
      for (const a of rows) {
        console.log(`      [${a.entry.disposition}] ${a.key.replace(`fidelity:`, '').replace(` ${url} `, ' ')}`)
        console.log(`          ${a.entry.note}`)
      }
    }
  }
  if (acceptance.acceptErrors.length) {
    console.log(`\n[fidelity] ✗ fidelity/accepted.json is malformed (${acceptance.acceptErrors.length}):`)
    for (const e of acceptance.acceptErrors) console.log(`      ${e}`)
  }
  if (acceptance.stale.length) {
    console.log(`\n[fidelity] ✗ ${acceptance.stale.length} STALE accepted entr${acceptance.stale.length === 1 ? 'y' : 'ies'}` +
      ' — the difference no longer occurs, so the file now claims a discrepancy that is fixed. Prune it:')
    for (const k of acceptance.stale) console.log(`      ${k}`)
  }

  console.log(`\n[fidelity] ${counts.regressed} page(s) with regressions; ${counts.converted - counts.regressed} clean` +
    (acceptance.accepted.length ? `; ${acceptance.accepted.length} accepted difference(s)` : '') + '.')
}

function printCompleteness (c) {
  const LIMIT = 50
  const list = (rows, fmt) => {
    for (const r of rows.slice(0, LIMIT)) console.log(`      ${fmt(r)}`)
    if (rows.length > LIMIT) console.log(`      ... +${rows.length - LIMIT} more (build/diff/fidelity-report.json)`)
  }
  if (c.ok) {
    console.log(`[fidelity] strict: all ${c.expected} live page(s) have a golden and a converted page`)
    return
  }
  if (c.scopedSnapshot) {
    console.log(`\n[fidelity] ✗ strict: the golden snapshot is scoped to component=${c.scopedSnapshot}, not the full corpus`)
  }
  if (c.missingGolden.length) {
    console.log(`\n[fidelity] ✗ strict: ${c.missingGolden.length} live page(s) have NO golden -- every layer skips them:`)
    list(c.missingGolden, (r) => `${r.url}${r.error ? `  (render failed: ${r.error})` : ''}`)
  }
  if (c.notConverted.length) {
    console.log(`\n[fidelity] ✗ strict: ${c.notConverted.length} live page(s) have no converted page in the build:`)
    list(c.notConverted, (u) => u)
  }
}

main()
