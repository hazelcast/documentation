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

  const { manifest, lockfile } = emitManifest({ contentCatalog, playbook, outDir })
  console.log(
    `[index-pass] wrote ${manifest.counts.resources} resources across ${manifest.counts.components} components, ` +
      `${lockfile.counts.sources} pinned sources -> ${outDir}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
