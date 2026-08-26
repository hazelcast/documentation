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

// The site's own anchor scheme for an API operation, so the link the converter
// writes and the id the page renders come from ONE definition (see
// plugins/lib/api-anchors.js). Reaching out of migration/ into the permanent
// tree is deliberate and already the pattern here (substitute-attributes):
// this tooling is deleted after the migration, and the anchors are not.
const { HTTP_METHODS, operationAnchor } = require('../../../plugins/lib/api-anchors')

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

// Undo Asciidoctor's SUBSCRIPT substitution inside a link target.
//
// A JSON-pointer fragment escapes `/` as `~1`, so an xref into an API reference
// carries runs of `~`:
//   xref:integrate:client-filtering.adoc#/paths/~1rest~1clusters~1…~1lists/post
// Asciidoctor applies its normal inline substitutions to a macro TARGET as well
// as to prose, and a pair of `~` around text is subscript markup -- so the golden
// href reads `#/paths/<sub>1rest</sub>1clusters<sub>1%7Bcluster%7D</sub>1client…`.
// The link is dead on the live site today for exactly this reason.
//
// Restoring the `~` is not a rewrite of the author's target, it is undoing a
// substitution that should never have applied to it. Only ever a no-op elsewhere:
// `<` and `>` are illegal in a URL, so a genuine href cannot contain <sub> --
// and across the whole golden corpus this matches 2 links on one page (management-
// center clusters/create-filter-lists-rest), on every version of it.
//
// Restoring the `~` is only half the job — see repairApiDeepLink below for what
// the fragment is then retargeted to.
const MANGLED_SUBSCRIPT = /<sub>([^<]*)<\/sub>/g
const unmangleSubscripts = (href) => String(href || '').replace(MANGLED_SUBSCRIPT, '~$1~')

// A JSON pointer at a spec's operation node: `/paths/<escaped path>/<method>`.
// The path segment cannot contain a literal `/` (a JSON pointer escapes it as
// `~1`), which is what makes the three parts unambiguous.
const LEGACY_OPERATION_POINTER = new RegExp(`^/paths/([^/]+)/(${HTTP_METHODS.join('|')})$`, 'i')

// RFC 6901 unescaping: `~1` before `~0`, or a path containing a literal `~`
// would be corrupted. Percent-decoding first, because the authored pointers
// encode the braces of a path parameter (`%7Bcluster%7D`).
function decodePointerSegment (segment) {
  let decoded
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return null // malformed percent-encoding: not a pointer we can read
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~')
}

// Repair a deep link into an API reference page, in the two steps the golden
// needs: undo the subscript damage, then retarget the fragment from the JSON
// pointer the source authored to the anchor the SITE publishes.
//
// The second step is not cosmetic. A pointer is not an anchor anyone could have
// looked up — there is no affordance on the page that produces one, which is why
// the two links in the corpus carry a form that only ever worked by being copied
// from another link. The site publishes an ordinary heading-style slug for every
// operation instead (plugins/lib/api-anchors.js, the same module the build-time
// plugin registers them from), so the converted link points at an anchor a
// contributor can also obtain by hovering the heading — and one that Docusaurus
// validates, so the next person to mistype one is told.
//
// Both steps are no-ops on any other href, so this is safe to apply to all of
// them: `<`/`>` cannot occur in a real URL, and a fragment only retargets if it
// parses as an operation pointer.
function repairApiDeepLink (href) {
  const restored = unmangleSubscripts(href)
  const hash = restored.indexOf('#')
  if (hash === -1) return restored
  const m = LEGACY_OPERATION_POINTER.exec(restored.slice(hash + 1))
  if (!m) return restored
  const specPath = decodePointerSegment(m[1])
  if (!specPath) return restored
  return restored.slice(0, hash) + '#' + operationAnchor(m[2], specPath)
}

module.exports = {
  resolveHref, EXTERNAL, attrHrefTemplates, unmangleSubscripts, repairApiDeepLink,
}
