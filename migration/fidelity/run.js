'use strict'

// The fidelity runner: compares each CONVERTED Docusaurus page against its
// GOLDEN Antora counterpart across all three layers, and reports only
// regressions the conversion introduced. Local, on-demand (no CI yet, per
// [[docusaurus-migration-git-strategy]]). Run:
//
//   node fidelity/run.js [--component X] [--id /url] [--layer 1,2,3]
//                        [--build-dir ../build] [--golden build/golden]
//                        [--manifest build/manifest] [--json]
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

const { goldenPages, resolveConverted } = require('./lib/pairing')
const { buildIndex } = require('./lib/manifest-index')
const { loadAnchorIndex } = require('./lib/anchor-index')
const { loadInventoryIndex } = require('./lib/inventory-index')
const { loadBaseline, novelProblems } = require('./lib/baseline')
const { checkPage } = require('./lib/layer3')
const { inventory, ASCIIDOC_PROFILE, DOCUSAURUS_PROFILE } = require('./lib/structure')
const { compareInventory } = require('./lib/layer2')
const { canonicalize, diffSegments, GOLDEN_STRIP, DOCUSAURUS_STRIP } = require('./lib/layer1')
const { extractMain } = require('./lib/extract-main')
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
  const baseline = loadBaseline(opts.goldenDir, l3deps, currentKey, path.join(opts.goldenDir, 'layer3-baseline.json'))

  // --- scope ---------------------------------------------------------------
  let pages = goldenPages(opts.goldenDir)
  if (opts.component) pages = pages.filter((p) => p.component === opts.component)
  if (opts.id) pages = pages.filter((p) => p.url === opts.id)

  // --- per-page comparison -------------------------------------------------
  const report = []
  let converted = 0
  let pending = 0
  let regressed = 0
  for (const p of pages) {
    const convertedFile = resolveConverted(opts.buildDir, p.url)
    if (!convertedFile) { pending++; continue }
    converted++
    const fullHtml = fs.readFileSync(convertedFile, 'utf8')
    const fragment = extractMain(fullHtml)
    const entry = { url: p.url, l1: [], l2: [], l3: [] }
    if (fragment == null) {
      entry.error = 'no main-content container found'
      report.push(entry); regressed++; continue
    }
    const goldenHtml = fs.readFileSync(p.file, 'utf8')

    if (opts.layers.has('1')) {
      const g = canonicalize(goldenHtml, { stripSelectors: GOLDEN_STRIP })
      const c = canonicalize(fragment, { stripSelectors: DOCUSAURUS_STRIP })
      entry.l1 = diffSegments(g, c)
    }
    if (opts.layers.has('2')) {
      const g = inventoryIndex.get(p.url) || inventory(goldenHtml, ASCIIDOC_PROFILE)
      const c = inventory(fragment, DOCUSAURUS_PROFILE)
      entry.l2 = compareInventory(g, c)
    }
    if (opts.layers.has('3')) {
      const problems = checkPage({ html: fragment, pageUrl: p.url, fragment: true }, l3deps)
      entry.l3 = novelProblems(p.url, problems, baseline)
    }
    if (entry.l1.length || entry.l2.length || entry.l3.length) { regressed++; report.push(entry) }
  }

  writeReport(opts, meta, { total: pages.length, converted, pending, regressed }, report)
  process.exit(regressed > 0 ? 1 : 0)
}

function writeReport (opts, meta, counts, report) {
  const outDir = path.resolve('build/diff')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'fidelity-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), scope: { component: opts.component, id: opts.id, layers: [...opts.layers] }, counts, report }, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify({ counts, report })); return }

  const scope = opts.id ? `id=${opts.id}` : opts.component ? `component=${opts.component}` : 'all components'
  console.log(`\n[fidelity] ${scope}  layers=${[...opts.layers].join(',')}  pin ${meta.lockfileKey.slice(0, 12)} OK`)
  console.log(`[fidelity] golden pages in scope: ${counts.total} | converted found: ${counts.converted} | not yet converted: ${counts.pending}`)
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
  console.log(`\n[fidelity] ${counts.regressed} page(s) with regressions; ${counts.converted - counts.regressed} clean.`)
}

main()
