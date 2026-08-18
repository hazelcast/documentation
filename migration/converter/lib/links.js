'use strict'

// Resolve an Asciidoctor golden `href` to what the MDX should emit.
//
// Antora has already resolved every xref to a FINAL, page-relative URL in the
// golden HTML (e.g. from /cloud/cluster-side-modules: `serverless-cluster`,
// `../hazelcast/5.7/sql/sql-statements`, `#section-id`). We turn those into
// site-ABSOLUTE paths so the emitted link does not depend on the MDX file's
// location in the Docusaurus route tree, and so it renders to exactly the URL
// the fidelity Layer-3 resolver checks against manifest.json.
//
// Classification mirrors fidelity/lib/links.js so both sides agree on what is
// external vs internal vs a same-page anchor.

const EXTERNAL = /^(https?:|mailto:|tel:|ftp:)/i

// pageUrl is the site-absolute URL of the page being converted, e.g.
// "/cloud/cluster-side-modules" or a directory URL "/cloud/".
function resolveHref (raw, pageUrl) {
  if (!raw) return { kind: 'empty', href: raw }
  if (EXTERNAL.test(raw) || raw.startsWith('//')) return { kind: 'external', href: raw }
  if (raw.startsWith('#')) return { kind: 'anchor', href: raw }

  // Resolve the (possibly ../-laden) relative href against the page URL using
  // real URL semantics, then keep only the site-absolute path + hash.
  let u
  try {
    u = new URL(raw, 'https://h' + pageUrl)
  } catch {
    return { kind: 'malformed', href: raw }
  }
  return { kind: 'internal', href: u.pathname + u.hash, path: u.pathname, hash: u.hash }
}

// Every LINK TARGET in a page's AsciiDoc source that contains an `{attribute}`
// reference, as written — the raw template, e.g.
//   `https://github.com/hazelcast/hazelcast/tree/v{page-latest-supported-hazelcast}.0/…`
//   `{page-cloud-console}settings/developer`
//
// These are the references the value reverse-map structurally cannot recover. It
// matches a resolved VALUE back in the rendered href, so it needs to know where
// the value ends — and in a URL it cannot, because the author writes more text
// straight after the reference (`.0`, `settings/developer`). The boundary rule
// that makes the fence path safe is exactly what has to refuse these: a version
// followed by `.0` is not a whole version (see varCodeTokenRe in html-to-mdx.js).
//
// The template sidesteps the question. Substituting the version's values into it
// reproduces the finished URL Antora put in the golden, so the converter can
// recognise that href by EXACT EQUALITY and emit the template — no inference
// about where a value starts or stops.
//
// Two macro forms carry a target: explicit `link:TARGET[` and a bare
// `https://TARGET[` (Asciidoctor auto-links a URL followed by a label). `xref:`
// is deliberately excluded: its attribute references are version COORDINATES,
// resolved by Antora during classification and handled by the latestVersions
// path, not by substitution. Targets cannot contain whitespace.
const LINK_TARGET = /(?:link:|(?<![\w:])(?=https?:\/\/))(\S*?)\[/g
function attrHrefTemplates (text) {
  const out = new Set()
  if (!text) return out
  for (const m of String(text).matchAll(LINK_TARGET)) {
    const target = m[1]
    if (target && /\{[A-Za-z0-9_][A-Za-z0-9_-]*\}/.test(target)) out.add(target)
  }
  return out
}

module.exports = { resolveHref, EXTERNAL, attrHrefTemplates }
