'use strict'

// The CLOSED disposition table: for each position an attribute reference can
// reach in rendered HTML, must the converted MDX still carry a reference there?
//
// This is the whole "expected failures" problem solved structurally. The old
// checker flagged references that were CORRECT to bake (a page title, an image's
// alt text) and told the reader to triage them into a name-keyed allowlist -- so
// the gate was permanently noisy and exempting `{hazelcast-cloud}` for a title
// also blinded it to a baked `{hazelcast-cloud}` three paragraphs down. Here a
// disposition attaches to the POSITION, not the name: the same attribute is
// expected to survive in prose on the very page where its alt-text occurrence is
// recorded as correctly baked.
//
// Every disposition is either 'preserve' (the MDX must carry a reference) or a
// 'bake:<reason>' (structurally impossible to preserve; counted, reported as a
// recorded consequence, never a finding). An UNRECOGNISED position returns null
// and the caller must fail: deny-by-default, so a new rendering context cannot
// quietly become an unchecked hole.

const PRESERVE = 'preserve'

// Text-node positions. All preserve: the converter has a form for each one --
// <Variable/> in prose and headings (with the golden anchor id pinned), and a
// `vars` code fence / the example-attributes webpack loader inside code.
const TEXT_CONTEXTS = {
  text: PRESERVE,
  heading: PRESERVE,
  code: PRESERVE,
}

// Element-attribute positions. `href` preserves (the converter emits a link-mode
// <Variable href="{name}"/>); the rest cannot hold a component or an interpolated
// value in the output, so they bake.
const ATTR_CONTEXTS = {
  href: PRESERVE,
  // A fragment-only href is the anchor link Asciidoctor puts next to a heading:
  // it points at that heading's own derived id, so it bakes for the same reason
  // the id does. Keyed separately from a real link destination, which preserves.
  'href#': 'bake:anchor-id',
  // Anchor ids are DERIVED from heading text, and Docusaurus needs the golden id
  // pinned as a literal to preserve the URL fragment -- an interpolated id would
  // break every inbound link the moment a value changed.
  id: 'bake:anchor-id',
  // Markdown image syntax has no expression slot for alt text or for the path.
  // Images are co-located and their paths rewritten at conversion, so the path is
  // necessarily literal.
  alt: 'bake:image-alt',
  src: 'bake:image-path',
  title: 'bake:tooltip',
}

// There is deliberately NO disposition for a title-derived xref label (a
// same-component `xref:target.adoc[]` with no label renders the target's TITLE as
// its link text, and titles bake into frontmatter). It needs none: Antora
// resolves a page's doctitle during content classification, before the census
// poisons anything, so a derived label reaches the census carrying the REAL
// value. No token, no expectation, no finding -- and by the same token a
// reference that reaches a page ONLY through a derived label is invisible to this
// gate. That is a known false negative, consistent with titles being baked, and
// it is the reason this table has no entry to tune: a first attempt at one
// (comparing link text to the target title) could not tell a derived label from
// an AUTHORED label that happens to read the same, and only ever produced false
// positives. If a derived label does start carrying a token, it surfaces as an
// ordinary baked finding rather than being silently exempted.

const dispositionForText = (context) => TEXT_CONTEXTS[context] || null
const dispositionForAttr = (attr) => ATTR_CONTEXTS[attr] || null
const isPreserve = (disposition) => disposition === PRESERVE

module.exports = {
  PRESERVE, TEXT_CONTEXTS, ATTR_CONTEXTS,
  dispositionForText, dispositionForAttr, isPreserve,
}
