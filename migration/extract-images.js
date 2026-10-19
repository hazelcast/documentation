'use strict'

// Place image assets from the pinned Antora sources into the Docusaurus docs
// tree, CO-LOCATED with the pages that use them.
//
// This is a pure CONSUMER of the placement plan the converter writes to
// build/image-placement.json. It does not decide where an image goes: that
// follows the reference graph and each page's output file, neither of which is
// derivable from the image's published URL (see lib/image-placement.js), and
// both of which only exist inside the converter. So the pipeline order is
//
//   fidelity:snapshot  ->  converter  ->  extract-images
//
// and this file's only job is to put the bytes where the plan says, then delete
// any image the plan no longer places.
//
//   node extract-images.js [path/to/playbook.yml] [--root DIR] [--component X] [--dry-run]
//
// Scope is whatever the plan covers, which is exactly the converted components
// and their live versions -- so no MIGRATED allowlist and no live-set gate are
// needed here any more, and an image no page references simply has no
// destination and is not placed. (There is deliberately no `--all`: an
// unreferenced image has no consumer to co-locate with, so placing it would
// mean reviving the flat per-component dump this layout exists to remove.)
//
// Idempotent: identical files are left untouched, so a re-run produces zero git
// churn unless an image actually changed upstream.

const fs = require('node:fs')
const path = require('node:path')

const buildPlaybook = require('@antora/playbook-builder')
const aggregateContent = require('@antora/content-aggregator')
const classifyContent = require('@antora/content-classifier')
const { resolveAsciiDocConfig } = require('@antora/asciidoc-loader')
const { configureLogger } = require('@antora/logger')

const { buildLockfile } = require('./antora-extension/emit-manifest')
const { lockfileKey, lockfileKeyFromFile } = require('./fidelity/lockfile-key')
const { IMAGES_DIR } = require('./lib/image-placement')
const { versionsToProcess, outDirFor } = require('./lib/layout')

// Images this large are worth a second look before they ship: they are almost
// always an uncompressed screen recording, and every live version keeps its own
// copy. Advisory only -- a big image can be the right call, and this is not a
// gate.
const SIZE_WARN_BYTES = 1_000_000

function parseArgs (argv) {
  const args = argv.slice(2)
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  const flagValues = new Set(['--root', '--component', '--lockfile', '--plan'].map((f) => args.indexOf(f) + 1))
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagValues.has(i))
  return {
    playbookFile: path.resolve(positional[0] || 'antora/index-playbook.yml'),
    // Site root: the plan's destinations are repo-relative, so joining them
    // under the Docusaurus project root lands them in the docs tree.
    rootDir: path.resolve(valueOf('--root', path.join(__dirname, '..'))),
    planFile: path.resolve(valueOf('--plan', 'build/image-placement.json')),
    component: valueOf('--component', null),
    lockfileFile: path.resolve(valueOf('--lockfile', 'build/manifest/lockfile.json')),
    dryRun: args.includes('--dry-run'),
  }
}

function loadPlan (planFile, component) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  } catch {
    console.error(
      `[extract-images] no placement plan at ${planFile} -- run the converter first ` +
        '(node converter/convert.js --component <x>), which computes where each image goes.'
    )
    process.exit(1)
  }
  // dest -> url. Scoped by where the copy goes, not by the image's home product:
  // a tutorial can show a Cloud image.
  const entries = Object.entries(raw.placements || {})
    .filter(([dest]) => !component || componentOfDest(dest) === component)
  return new Map(entries)
}

const componentOfDest = (dest) => dest.split('/')[0].replace(/_versioned_docs$/, '')

// The version trees the plan covers, so pruning can be scoped to directories
// this tool owns. Derived from the canonical layout helpers rather than by
// parsing destination paths, so it cannot drift from where the converter writes.
function ownedTrees (rootDir, components) {
  const trees = []
  for (const component of components) {
    for (const ver of versionsToProcess(component)) trees.push(outDirFor(rootDir, component, ver))
  }
  return trees
}

// Delete every file under an `images/` directory of an owned tree that this run
// did not place, then any `images/` directory that leaves empty. Without this a
// re-layout (or an image losing its last reference) would leave the old copy
// behind forever: the write path is idempotent by content and never removes.
// Scoped to `images/` directories so nothing else in the tree can be touched.
function pruneImages (trees, placed, dryRun) {
  let removed = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === IMAGES_DIR) sweep(p)
        else walk(p)
      }
    }
  }
  const sweep = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    let kept = 0
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { sweep(p); if (fs.existsSync(p)) kept++; continue }
      if (placed.has(p)) { kept++; continue }
      removed++
      if (!dryRun) fs.rmSync(p, { force: true })
    }
    if (kept === 0 && !dryRun) { try { fs.rmdirSync(dir) } catch { /* not empty after all */ } }
  }
  for (const t of trees) walk(t)
  return removed
}

async function main () {
  const { playbookFile, rootDir, planFile, component, lockfileFile, dryRun } = parseArgs(process.argv)

  const plan = loadPlan(planFile, component)
  if (plan.size === 0) {
    console.error(`[extract-images] the plan places no images${component ? ` for component=${component}` : ''}.`)
    process.exit(1)
  }
  const components = new Set([...plan.keys()].map(componentOfDest))
  const destsByUrl = new Map()
  for (const [dest, url] of plan) destsByUrl.set(url, [...(destsByUrl.get(url) || []), dest])
  console.log(`[extract-images] plan: ${plan.size} image(s) across ${[...components].sort().join(', ')}`)

  const playbook = buildPlaybook(['--playbook', playbookFile], {})
  configureLogger(playbook.runtime.log)

  const siteConfig = resolveAsciiDocConfig(playbook)
  console.log(`[extract-images] aggregating content from ${playbookFile} ...`)
  const aggregate = await aggregateContent(playbook)
  console.log(`[extract-images] classifying ${aggregate.length} component-version bundles ...`)
  const contentCatalog = classifyContent(playbook, aggregate, siteConfig)

  // Pin check: images should come from the same revision the manifest URLs were
  // resolved at. A mismatch is a warning, not a hard stop -- image filenames are
  // stable across revisions, so drifted bytes rarely mean a wrong URL (unlike the
  // golden snapshot, where a mismatched pin invalidates every diff).
  try {
    const renderedKey = lockfileKey(buildLockfile(contentCatalog))
    const committedKey = lockfileKeyFromFile(lockfileFile)
    if (committedKey !== renderedKey) {
      console.warn(
        '[extract-images] WARNING: local clones do not match the committed pin ' +
          `(${lockfileFile}). Extracting at the clones' current revision.`
      )
    }
  } catch { /* no committed lockfile yet -- nothing to check against */ }

  const images = contentCatalog.findBy({ family: 'image' })
    .filter((file) => file.pub && file.pub.url && destsByUrl.has(file.pub.url))

  const perComponent = {}
  const placed = new Set()
// Docusaurus measures every image with `image-size` to set intrinsic width/height
// (so the page does not shift as images load). Its SVG probe reads only the FIRST
// 1000 BYTES and needs the whole `<svg ...>` root tag inside them -- and a
// diagrams.net export carries a `content="&lt;mxfile ...&gt;"` attribute holding
// the entire editable diagram, which pushes that tag past 3KB. The image is
// perfectly valid; the probe just cannot see its dimensions, so it warns and the
// image renders with no intrinsic size.
//
// Stripped from the PUBLISHED copy only. The attribute is editor metadata -- it
// is what lets diagrams.net reopen the .svg for editing -- and since there is no
// separate .drawio file in the sources, that attribute IS the editable master.
// Removing it here keeps the source asset intact and untouched while shipping an
// SVG the probe can measure. Nothing about the rendered drawing changes: `content`
// is not referenced by any painting attribute.
const MXFILE_CONTENT = /\scontent="(?:&lt;|<)mxfile[\s\S]*?"(?=[\s>])/
// The probe's own root-tag pattern and read limit, so "can it be measured?" is
// asked the way image-size asks it rather than re-derived from byte offsets (an
// XML declaration or a DOCTYPE puts a `>` long before the root tag).
const SVG_ROOT = /<svg\s([^>"']|"[^"]*"|'[^']*')*>/
const PROBE_BYTES = 1000

function stripDrawioSource (file, contents) {
  if (!/\.svg$/i.test(file.pub.url || '')) return contents
  if (SVG_ROOT.test(contents.subarray(0, PROBE_BYTES).toString('utf8'))) return contents
  const text = contents.toString('utf8')
  const out = text.replace(MXFILE_CONTENT, '')
  return out === text ? contents : Buffer.from(out, 'utf8')
}

  const heavy = []
  let written = 0
  let unchanged = 0
  let skipped = 0
  for (const file of images) {
    const contents = stripDrawioSource(file, file.contents)
    if (!contents || !contents.length) { skipped++; continue }
    if (contents.length > SIZE_WARN_BYTES) heavy.push({ bytes: contents.length, url: file.pub.url })
    for (const rel of destsByUrl.get(file.pub.url)) {
      const dest = path.join(rootDir, rel)
      placed.add(dest)

      let changed = true
      try {
        changed = !fs.readFileSync(dest).equals(contents)
      } catch { /* absent -> write it */ }

      const key = file.src.component + (file.src.version ? `@${file.src.version}` : '')
      perComponent[key] = perComponent[key] || { written: 0, unchanged: 0 }
      if (!changed) { unchanged++; perComponent[key].unchanged++; continue }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, contents)
    }
    written++
    perComponent[key].written++
    }
  }

  const missing = [...destsByUrl.keys()].filter((url) => !images.some((f) => f.pub.url === url))
  const removed = pruneImages(ownedTrees(rootDir, components), placed, dryRun)

  console.log(
    `[extract-images] ${dryRun ? '[dry-run] would write' : 'wrote'} ${written} image(s), ` +
      `${unchanged} unchanged` + (skipped ? `, ${skipped} empty skipped` : '') +
      (removed ? `, ${dryRun ? 'would remove' : 'removed'} ${removed} stale` : '') +
      ` -> ${rootDir}`
  )
  for (const key of Object.keys(perComponent).sort()) {
    const c = perComponent[key]
    console.log(`  ${key.padEnd(32)} ${c.written} written, ${c.unchanged} unchanged`)
  }
  // Every version keeps its OWN copy of every image (a deliberate decision -- no
  // sharing across versions), so one heavy source file is paid for once per live
  // version. Report the source images, largest first.
  if (heavy.length) {
    const bySrc = new Map()
    for (const h of heavy) {
      const name = h.url.split('/').pop()
      bySrc.set(name, { bytes: h.bytes, copies: (bySrc.get(name) || { copies: 0 }).copies + 1 })
    }
    console.warn(`\n[extract-images] ${bySrc.size} image(s) over ${(SIZE_WARN_BYTES / 1e6).toFixed(1)} MB:`)
    for (const [name, v] of [...bySrc].sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.warn(`  ${(v.bytes / 1e6).toFixed(2)} MB  ${name}` + (v.copies > 1 ? `  x${v.copies} versions` : ''))
    }
  }
  // A planned image with no file in the catalog means the plan and the pinned
  // sources disagree -- a stale plan, or a page referencing an image that was
  // deleted upstream. The site build would fail on it later; say so now.
  if (missing.length) {
    console.error(`\n[extract-images] ${missing.length} planned image(s) NOT FOUND in the sources:`)
    for (const url of missing.slice(0, 10)) console.error(`  ${url}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
