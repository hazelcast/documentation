'use strict'

// The anchor id of one operation on an API reference page.
//
// Neither of the two ids these pages already carry is something a docs
// contributor can reasonably write down. Antora's swagger_ui pages anchored an
// operation by the JSON POINTER of its spec node --
// `#/paths/~1rest~1clusters~1{cluster}~1clientfiltering~1lists/post` -- and that
// is the form that ended up copy-pasted into the AsciiDoc sources. Redoc anchors
// it by an id of its own, `#operation/createFilteringRules`, which reads better
// but only exists where the spec gives an `operationId`: the WAN spec gives none
// for any of its 13 operations, so there Redoc falls back to the pointer again.
//
// So the site publishes its own, an ordinary heading-style slug of the two things
// that identify an operation in the spec -- its METHOD and its PATH:
//
//   post /rest/clusters/{cluster}/clientfiltering/lists
//     -> post-rest-clusters-cluster-clientfiltering-lists
//
// Method + path rather than the operation's summary, because a summary is prose:
// it gets reworded upstream and every anchor into that operation would rot.
// Method + path IS the operation's identity, and changing either is a breaking
// API change -- the one time the anchor SHOULD move.
//
// Shared by the plugin that REGISTERS these anchors at build time
// (plugins/openapi-specs, reading the spec document) and the component that
// RENDERS them (src/components/ApiReference/Operation, reading Redoc's model of
// the same document), so the id Docusaurus validates a link against and the id
// actually on the page cannot drift apart. Checked over all five Management
// Center specs: 69 operations, no collisions.

// OpenAPI's fixed set of path-item operation keys. A path item also holds
// non-operation keys (`summary`, `parameters`, `servers`, `$ref`), so the
// methods are listed rather than inferred from what is there.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function operationAnchor (method, specPath) {
  return slug(`${method}-${specPath}`)
}

// Every operation anchor a bundled OpenAPI document will render, in document
// order. `paths` only: nothing in the corpus uses webhooks or callbacks as
// top-level entries, and registering an anchor for something that never renders
// would validate a link that then cannot scroll -- the failure mode that is
// harder to notice than a warning.
function specAnchors (spec) {
  const anchors = []
  for (const [specPath, pathItem] of Object.entries((spec && spec.paths) || {})) {
    if (!pathItem) continue
    for (const method of HTTP_METHODS) {
      if (pathItem[method]) anchors.push(operationAnchor(method, specPath))
    }
  }
  return anchors
}

module.exports = { HTTP_METHODS, operationAnchor, specAnchors }
