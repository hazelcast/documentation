'use strict'

// Attributes that are legitimately fine to leave baked (resolved) in the
// converted MDX -- so the no-baking checker does NOT flag them. This is a
// DELIBERATE allowlist: an entry says "we looked, and this value never needs to
// stay a single-sourced reference." Add to it only during triage of a real
// finding, with the reasoning in a comment.
//
// Two things are excluded WITHOUT living here, because they are not doc content
// attributes at all and the checker filters them earlier:
//   - names not present in the component's manifest attribute table (Antora
//     built-ins resolved per page/context: {description}, positional {0}, …);
//   - attributes whose resolved value is empty.
//
// What remains — and therefore what this list is for — are real, non-empty
// component attributes that are pure Asciidoctor/Antora machinery, never
// rendered as prose the reader single-sources. Product-name / version / URL
// attributes are deliberately NOT here: those are exactly what must stay
// references, so they should flag until variableised (or added here with a
// justification).
const BAKE_SAFE = new Set([
  // Asciidoctor/Antora environment + rendering config. Never authored as a
  // prose {ref}; if one appears it is machinery, not single-sourceable content.
  'env', 'env-site', 'site-gen', 'site-gen-antora', 'site-title',
  'attribute-missing', 'data-uri', 'icons', 'sectanchors', 'source-highlighter',
  'idprefix', 'idseparator',
  // Antora page/component layout knobs (control nav/toc/versions, not content).
  'page-toclevels', 'page-pagination', 'page-component-order',
  'page-excluded-versions', 'page-last-versions-count', 'page-experimental',
  'snapshot',
])

const isBakeSafe = (name) => BAKE_SAFE.has(name)

module.exports = { BAKE_SAFE, isBakeSafe }
