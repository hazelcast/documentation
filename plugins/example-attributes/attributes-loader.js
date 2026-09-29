'use strict'

// Build-time webpack loader: substitutes {attribute} placeholders in example files, so the source
// files stay byte-faithful while the rendered code block shows the per-version value.
// Runs before raw-loader. Values come from loader options (src/variables.ts); the version is derived
// from the file path (`<component>_versioned_docs/version-X/examples/` or `<component>/examples/`).
// Unknown `{names}` are left literal.

const path = require('node:path')
const substitute = require('../lib/substitute-attributes')

// Component + Docusaurus version name from the file's absolute path.
function scopeFromPath (resourcePath) {
  const p = resourcePath.split(path.sep).join('/')
  let m = p.match(/\/([a-z0-9-]+)_versioned_docs\/version-([^/]+)\/examples\//)
  if (m) return { component: m[1], version: m[2] }
  m = p.match(/\/([a-z0-9-]+)\/examples\//)
  if (m) return { component: m[1], version: 'current' }
  return { component: null, version: null }
}

module.exports = function exampleAttributesLoader (source) {
  const { variables = {}, versionedVariables = {} } = this.getOptions() || {}
  const { component, version } = scopeFromPath(this.resourcePath)
  const perVer = (component && versionedVariables[component] && versionedVariables[component][version]) || {}
  // Per-version values win over global ones.
  const lookup = { ...variables, ...perVer }
  return substitute(source, lookup)
}
