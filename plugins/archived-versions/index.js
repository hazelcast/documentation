'use strict'

const path = require('node:path')
const fs = require('node:fs')

// Archived versions are static Antora HTML on a separate Netlify site, built by the
// build-frozen-versions workflow in hazelcast-docs. This appends a 200 proxy rewrite per archived
// version to the built _redirects, so they keep their docs.hazelcast.com URLs. `/_/` is the Antora
// UI bundle every archived page loads.

const HEADER = '# Archived versions, served from the archive site (src/archivedVersions.json)'

// Versions whose archived page only linked to an external manual redirect straight to it.
function archiveRules ({origin, versions, redirects = {}}) {
  const prefixes = ['_', ...Object.entries(versions).flatMap(([product, list]) => list.map((v) => `${product}/${v}`))]
  const external = Object.entries(redirects).flatMap(([product, targets]) =>
    Object.entries(targets).flatMap(([v, url]) => [`/${product}/${v}  ${url}  301!`, `/${product}/${v}/*  ${url}  301!`]),
  )
  return [HEADER, ...prefixes.map((p) => `/${p}/*  ${origin}/${p}/:splat  200`), ...external].join('\n') + '\n'
}

module.exports = function archivedVersionsPlugin (context, options) {
  return {
    name: 'archived-versions',
    async postBuild ({outDir}) {
      const file = path.join(outDir, '_redirects')
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : ''
      fs.writeFileSync(file, existing + separator + archiveRules(options))
    },
  }
}

module.exports.archiveRules = archiveRules
