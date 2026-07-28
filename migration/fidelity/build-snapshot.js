'use strict'

// Golden-snapshot builder. Renders the Antora main-content HTML for every
// migrated page at the PINNED BASELINE -- the SHAs recorded in the lockfile,
// NOT live upstream -- and writes it to a gitignored tree under build/golden/,
// keyed to that pin. This is the "before" image every fidelity layer diffs
// against. It is the expensive step (full document conversion, which the index
// pass deliberately skips), so it is built deliberately and cached, never
// re-run on every fidelity check. Regenerate with `npm run fidelity:snapshot`.
//
//   node fidelity/build-snapshot.js [path/to/playbook.yml] [--out DIR] [--lockfile FILE]
//
// It reuses the index-pass playbook so sources and pins are identical to
// manifest.json. Each page is rendered with its own component-version AsciiDoc
// config, so per-version conditionals (e.g. ifdef::snapshot on the
// 5.8-snapshot prerelease) resolve exactly as they do in production. Output is
// embeddable body HTML (the main content), so there is no site chrome to strip.
//
// LIMITATION: extensions registered only in the production hazelcast-docs
// playbook are not loaded here (notably the swagger-ui block macro). The 6
// Swagger pages are a separate fidelity category and are expected to render
// imperfectly in this snapshot.

const fs = require('node:fs')
const path = require('node:path')

const buildPlaybook = require('@antora/playbook-builder')
const aggregateContent = require('@antora/content-aggregator')
const classifyContent = require('@antora/content-classifier')
const { loadAsciiDoc, resolveAsciiDocConfig } = require('@antora/asciidoc-loader')
const { configureLogger } = require('@antora/logger')

const { buildLockfile } = require('../antora-extension/emit-manifest')
const { registerPageAliases } = require('../antora-extension/register-page-aliases')
const { lockfileKey, lockfileKeyFromFile } = require('./lockfile-key')

// Components we actually migrate (convert + emit to the golden tree). Everything
// else in the build (imdg, tutorials + its 56 guide repos, ...) is
// resolution-only: kept in the catalog + manifest so cross-component xrefs
// resolve as production does, but never emitted here. An allowlist is used (not
// a denylist) so any resolution-only component is excluded regardless of the
// component name its repo declares.
const MIGRATED = new Set([
  'hazelcast', 'management-center', 'clc', 'operator', 'cloud', 'jdbc-driver', 'home', 'privacy',
])

function parseArgs (argv) {
  const args = argv.slice(2)
  const flagValueIdxs = new Set()
  for (const flag of ['--out', '--lockfile', '--component']) {
    const i = args.indexOf(flag)
    if (i !== -1) flagValueIdxs.add(i + 1)
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagValueIdxs.has(i))
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  return {
    playbookFile: path.resolve(positional[0] || 'antora/index-playbook.yml'),
    outDir: path.resolve(valueOf('--out', 'build/golden')),
    lockfileFile: path.resolve(valueOf('--lockfile', 'build/manifest/lockfile.json')),
    // Optional: render only this one component (e.g. --component cloud). The
    // full playbook still aggregates, so the pin check stays valid; only the
    // render/write step is scoped. Handy for a fast smoke test.
    component: valueOf('--component', null),
  }
}

// version@component -> that component version's resolved AsciiDoc config, so
// each page renders with its own attributes/conditionals. Mirrors what
// @antora/document-converter does internally.
function asciidocConfigsByVersion (contentCatalog, siteConfig) {
  const map = new Map()
  for (const component of contentCatalog.getComponents()) {
    for (const v of component.versions) {
      map.set(`${v.version}@${component.name}`, v.asciidoc || siteConfig)
    }
  }
  return map
}

async function main () {
  const { playbookFile, outDir, lockfileFile, component } = parseArgs(process.argv)

  const playbook = buildPlaybook(['--playbook', playbookFile], {})
  configureLogger(playbook.runtime.log)

  const siteConfig = resolveAsciiDocConfig(playbook)
  console.log(`[snapshot] aggregating content from ${playbookFile} ...`)
  const aggregate = await aggregateContent(playbook)
  console.log(`[snapshot] classifying ${aggregate.length} component-version bundles ...`)
  const contentCatalog = classifyContent(playbook, aggregate, siteConfig)

  // The pin is defined by lockfile.json. The snapshot MUST be built from that
  // exact pin, or every later diff compares against the wrong "before". Verify
  // it BEFORE spending time rendering, and hard-fail on any mismatch (a drifted
  // local clone). This is an internal-consistency check against our own
  // committed lockfile -- it never consults origin and never chases upstream.
  const renderedKey = lockfileKey(buildLockfile(contentCatalog))
  let committedKey = null
  try {
    committedKey = lockfileKeyFromFile(lockfileFile)
  } catch { /* no committed lockfile yet -- this snapshot defines the pin */ }
  if (committedKey && committedKey !== renderedKey) {
    console.error(
      `[snapshot] ABORT: local clones do not match the committed pin (${lockfileFile}).\n` +
        '           Reconcile them (re-fetch + re-run the index pass, or reset the clones)\n' +
        '           so the snapshot and manifest share a pin, then rebuild.'
    )
    process.exit(1)
  }

  // Register page aliases BEFORE rendering so xrefs to renamed/moved pages
  // resolve exactly as production does (the site generator does this; classify
  // alone does not). Without it the golden snapshot renders those links broken.
  const aliases = registerPageAliases(contentCatalog, siteConfig)
  console.log(`[snapshot] registered ${aliases.registered} page aliases` +
    (aliases.problems.length ? ` (${aliases.problems.length} skipped)` : ''))

  const configs = asciidocConfigsByVersion(contentCatalog, siteConfig)
  const pagesDir = path.join(outDir, 'pages')
  fs.rmSync(pagesDir, { recursive: true, force: true })

  const pages = contentCatalog
    .getPages((page) => page.out)
    .filter((page) => component
      ? page.src.component === component
      : MIGRATED.has(page.src.component))
  console.log(
    `[snapshot] rendering ${pages.length} pages` + (component ? ` (component=${component})` : '') + ' ...'
  )

  const errors = []
  let written = 0
  for (const page of pages) {
    const cvKey = `${page.src.version}@${page.src.component}`
    try {
      const html = loadAsciiDoc(page, contentCatalog, configs.get(cvKey) || siteConfig).convert()
      const dest = path.join(pagesDir, page.out.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, html.endsWith('\n') ? html : html + '\n')
      written++
    } catch (err) {
      errors.push({ id: `${cvKey}:${page.src.module}:${page.src.relative}`, message: err.message })
    }
  }

  const meta = {
    builtAt: new Date().toISOString(),
    lockfileKey: renderedKey,
    playbook: path.relative(process.cwd(), playbookFile),
    // null = full corpus; a component name = a scoped (smoke) snapshot, NOT a
    // complete golden tree.
    component: component || null,
    counts: { pages: pages.length, written, errors: errors.length },
    versions: { antora: require('@antora/content-classifier/package.json').version },
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'snapshot-meta.json'), JSON.stringify(meta, null, 2) + '\n')
  if (errors.length) {
    fs.writeFileSync(path.join(outDir, 'snapshot-errors.json'), JSON.stringify(errors, null, 2) + '\n')
  }

  console.log(
    `[snapshot] wrote ${written}/${pages.length} pages to ${pagesDir}` +
      (errors.length ? ` (${errors.length} failed -> snapshot-errors.json)` : '') +
      `\n[snapshot] key ${renderedKey.slice(0, 12)} -> ${path.join(outDir, 'snapshot-meta.json')}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
