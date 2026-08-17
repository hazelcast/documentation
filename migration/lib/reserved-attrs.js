'use strict'

// The closed registry of RESERVED attribute names: Asciidoctor rendering config
// and Antora site/page machinery. None of them is doc content -- no page single-
// sources one as prose -- and several CHANGE THE RENDER if altered
// (idprefix/idseparator rewrite every anchor id, `env` is compared by ifeval,
// page-excluded-versions decides which versions Antora emits at all). The census
// render therefore leaves them at their real values (see
// antora-extension/poison-attributes.js), which also means a reference to one is
// never expected to survive as a <Variable> in the converted MDX.
//
// Membership is decided by the Asciidoctor/Antora attribute registries, NOT by
// what happens to break when a value is changed. Anything NOT listed here is
// treated as content and is poisoned, so a newly-introduced content attribute is
// covered by default -- the list fails toward MORE checking, never less. Add a
// name only with the reason it is machinery.
//
// This replaced refcheck/lib/bake-safe.js, whose entries were the same set under
// a weaker contract ("fine to leave baked"). Under the census gate a reserved
// name is not "allowed to be baked", it is never rendered from a reference in the
// first place, so there is nothing to allow.
const RESERVED = new Set([
  // --- Asciidoctor environment + rendering config -------------------------
  'env', 'env-site',              // ifdef/ifeval subject: changing it flips branches
  'site-gen', 'site-gen-antora',  // ditto
  'attribute-missing',            // resolution behaviour for undefined refs
  'data-uri', 'icons', 'source-highlighter', 'sectanchors',
  'idprefix', 'idseparator',      // anchor-id derivation for the whole document

  // --- Antora site + page machinery ---------------------------------------
  'site-title', 'site-url',       // consumed by Antora to build the site/URLs
  'page-component-order', 'page-excluded-versions', 'page-last-versions-count',
  'page-pagination', 'page-experimental', 'page-toclevels',
  'snapshot',                     // ifdef flag for prerelease-only content
])

const isReserved = (name) => RESERVED.has(name)

module.exports = { RESERVED, isReserved }
