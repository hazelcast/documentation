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

module.exports = { resolveHref, EXTERNAL }
