'use strict'

// Standalone global index pass. Runs Antora's own aggregator + classifier
// (no UI download, no document conversion) against the migration playbook and
// writes manifest.json + lockfile.json. Read-only: it never touches the source
// repos beyond the git fetch Antora does into its cache dir.
//
//   node index-pass.js [path/to/playbook.yml] [--out DIR]

const path = require('node:path')

const buildPlaybook = require('@antora/playbook-builder')
const aggregateContent = require('@antora/content-aggregator')
const classifyContent = require('@antora/content-classifier')
const { resolveAsciiDocConfig } = require('@antora/asciidoc-loader')
const { configureLogger } = require('@antora/logger')

const { emitManifest } = require('./antora-extension/emit-manifest')
const { registerPageAliases } = require('./antora-extension/register-page-aliases')

async function main () {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = path.resolve(outIdx === -1 ? 'build/manifest' : args[outIdx + 1])
  const playbookArg = args.find((a) => !a.startsWith('--') && a !== args[outIdx + 1]) || 'antora/index-playbook.yml'
  const playbookFile = path.resolve(playbookArg)

  const playbook = buildPlaybook(['--playbook', playbookFile], {})
  configureLogger(playbook.runtime.log)

  const siteAsciiDocConfig = resolveAsciiDocConfig(playbook)
  console.log(`[index-pass] aggregating content from ${playbookFile} ...`)
  const aggregate = await aggregateContent(playbook)
  console.log(`[index-pass] classifying ${aggregate.length} component-version bundles ...`)
  const contentCatalog = classifyContent(playbook, aggregate, siteAsciiDocConfig)

  // Register page aliases so the manifest includes alias URLs and links to
  // renamed pages resolve (classify alone does not do this).
  const aliases = registerPageAliases(contentCatalog, siteAsciiDocConfig)
  console.log(`[index-pass] registered ${aliases.registered} page aliases` +
    (aliases.problems.length ? ` (${aliases.problems.length} skipped)` : '') +
    `, captured ${aliases.titles.size} page titles`)

  const { manifest, lockfile } = emitManifest({ contentCatalog, playbook, outDir, titles: aliases.titles, badges: aliases.badges })
  console.log(
    `[index-pass] wrote ${manifest.counts.resources} resources across ${manifest.counts.components} components, ` +
      `${lockfile.counts.sources} pinned sources -> ${outDir}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
