'use strict'

const path = require('node:path')
const fs = require('node:fs')

// Emits /preview-pages.json in Netlify deploy previews: every doc's source file mapped to its URL path,
// e.g. { "hazelcast/sql/index.mdx": "/hazelcast/6.0-snapshot/sql" }. The preview-links workflow reads it
// to link a PR's changed pages. Taken from the docs plugins' loaded content, so slugs and versions resolve
// exactly as the site serves them.

const DOCS_PLUGIN_NAME = 'docusaurus-plugin-content-docs'
const OUT_PATH = 'preview-pages.json'

function pageMap (plugins) {
  const map = {}
  for (const plugin of plugins.filter((p) => p.name === DOCS_PLUGIN_NAME)) {
    for (const version of plugin.content?.loadedVersions ?? []) {
      for (const doc of version.docs) map[doc.source.replace(/^@site\//, '')] = doc.permalink
    }
  }
  return map
}

module.exports = function previewPagesPlugin () {
  return {
    name: 'preview-pages',

    async postBuild ({ outDir, plugins }) {
      // Netlify sets CONTEXT; production and local builds don't publish the file.
      if (process.env.CONTEXT !== 'deploy-preview') return
      fs.writeFileSync(path.join(outDir, OUT_PATH), JSON.stringify(pageMap(plugins)), 'utf8')
    },
  }
}

module.exports.pageMap = pageMap
