'use strict'

// Build-time webpack loader: substitutes Antora-style {attribute} placeholders
// in co-located example files at build. The co-located files stay BYTE-FAITHFUL
// to the engineers' source (placeholders intact — no baking at extract time),
// while the rendered code block shows the resolved, per-version value. It runs
// before raw-loader (see example-attributes-plugin.js) so it sees the raw file
// text and raw-loader then stringifies the result.
//
// Values come from loader OPTIONS ({ variables, versionedVariables }), which the
// plugin passes straight through from src/variables.ts (the single source) —
// the loader reads no file of its own. The version is derived from the file's
// path: a file under `<component>_versioned_docs/version-X/examples/` resolves
// against version X; one under `<component>/examples/` against the component's
// current version. Unknown `{names}` are left literal, exactly as Antora leaves
// undefined attributes.

const path = require('node:path')
const substitute = require('./lib/substitute-attributes')

// component + Docusaurus version name from the imported file's absolute path.
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
  // Per-version values win over any global (unversioned) name of the same key.
  const lookup = { ...variables, ...perVer }
  return substitute(source, lookup)
}
