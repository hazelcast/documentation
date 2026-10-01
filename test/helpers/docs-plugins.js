'use strict'

// Loads src/docsPlugins.ts or the whole docusaurus.config.ts as the build evaluates them. Building a versioned
// component's config writes its per-release sidebar stubs. These loaders remove the stubs they created and register
// no exit hook, so they never delete stubs a running build or dev server owns.

const fs = require('node:fs')
const path = require('node:path')
const {site, loadTs} = require('./load-ts')

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(site, rel), 'utf8'))

function withoutNewStubs (load) {
  const dirs = () => fs.readdirSync(site).filter((d) => d.endsWith('_versioned_sidebars'))
  const listStubs = () => new Set(dirs().flatMap((d) => fs.readdirSync(path.join(site, d)).map((f) => path.join(site, d, f))))
  const dirsBefore = new Set(dirs())
  const before = listStubs()
  globalThis.__hzSidebarStubCleanupHooked = true
  try {
    return load()
  } finally {
    for (const file of listStubs()) if (!before.has(file)) fs.rmSync(file)
    for (const dir of dirs()) if (!dirsBefore.has(dir)) fs.rmdirSync(path.join(site, dir))
  }
}

// Not in the package's exports map, so loaded by path.
const {getVersionBanner} = require(path.join(site, 'node_modules/@docusaurus/plugin-content-docs/lib/versions/version.js'))

// docsPlugins, each versioned component's plugin options keyed by id, and `versionsOf(id)`: every version of a
// component with its URL segment and the banner Docusaurus gives it ('unreleased', 'unmaintained', or null).
function loadDocsPlugins () {
  return withoutNewStubs(() => {
    const docsPlugins = loadTs('src/docsPlugins.ts')
    const ids = Object.keys(readJson('src/currentVersions.json'))
    const configs = Object.fromEntries(ids.map((id) => [id, docsPlugins.versionedDocs(id)[1]]))
    // Docusaurus lists `current` first, then the releases in <id>_versions.json order.
    const versionsOf = (id) => {
      const config = configs[id]
      const versionNames = ['current', ...readJson(`${id}_versions.json`)]
      return versionNames.map((versionName) => ({
        versionName,
        seg: config.versions[versionName].path,
        banner: getVersionBanner({versionName, versionNames, lastVersionName: config.lastVersion, options: config}),
      }))
    }
    return {docsPlugins, ids, configs, versionsOf}
  })
}

function loadSiteConfig () {
  return withoutNewStubs(() => loadTs('docusaurus.config.ts'))
}

module.exports = {loadDocsPlugins, loadSiteConfig, readJson}
