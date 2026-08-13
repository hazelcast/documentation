'use strict'

// Pure logic for the orphan gate. Nothing here touches Antora or the filesystem:
// run.js does the catalog I/O (resolving xref/include specs to page ids) and
// hands these functions plain data, so the interesting decisions — what counts
// as an xref, what a "logical page" is, orphan classification, and the
// deny-by-default allowlist — are unit-testable against the AsciiDoc grammar and
// the orphan definition directly (see selftest.js).

// An orphan is a PUBLISHED page not reachable from the site navigation. It splits
// by whether anything links to it at all:
//   unreachable — not in nav AND no inbound xref (dead unless you know the URL)
//   referenced  — not in nav BUT reachable via an xref from some page
// A page that is a nav entry, or a component/site landing page, is never an orphan.

// Dispositions a human records in the allowlist once they have triaged an orphan.
// The gate does not act on these (redirect emission is a later, separate step);
// it validates their shape so the decision — and crucially redirect-vs-404 — is
// captured honestly and auditably rather than living only in someone's head.
const DISPOSITIONS = new Set(['keep-in-nav', 'keep-referenced', 'redirect', 'drop-404'])

// Extract Antora xref macro targets from raw AsciiDoc. The macro is
// `xref:TARGET[...]` where TARGET is `[version@][component:][module:]relative[#frag]`
// with no whitespace. `<<id>>` is intentionally excluded: it references an anchor
// within the same document, so it never makes another PAGE reachable.
function xrefTargets (text) {
  const out = []
  const re = /xref:([^[\s]+)\[/g
  let m
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

// Extract Antora include directive targets. `include::TARGET[attrs]` is a block
// macro at the start of a line (leading whitespace tolerated). We expand includes
// before scanning xrefs so a link living in an included partial counts toward the
// page that pulls the partial in — without this, a page reachable only through a
// partial's xref is wrongly reported as unreachable.
function includeTargets (text) {
  const out = []
  const re = /^[ \t]*include::([^[\r\n]+)\[/gm
  let m
  while ((m = re.exec(text))) out.push(m[1].trim())
  return out
}

// The version-independent identity of a page: the same logical page in v/5.6,
// v/5.7 and main shares one key. This is the unit a human decides about ("drop
// teams-and-users") and so the unit the allowlist keys on — one entry covers a
// page across every branch it is orphaned in. ROOT (the default module) is
// elided and the `.adoc` suffix dropped, so the key reads like a URL tail:
//   {component}[:{module}]/{relative-without-.adoc}
//   -> "cloud:teams-and-users", "hazelcast:clients/rest"
function logicalKey ({ component, module, relative }) {
  const rel = String(relative).replace(/\.adoc$/, '')
  const mod = module && module !== 'ROOT' ? module + '/' : ''
  return `${component}:${mod}${rel}`
}

// Restrict the corpus to what the migration actually publishes: a component the
// migration builds, at a version in its live set. Orphan-ness is a property of a
// SITE, so a page can only be an orphan of the site that serves it. A page
// orphaned only in a frozen branch (clc 5.3.5, say) is served as static HTML by
// the frozen origin at its existing URL — this build has no page, no nav and no
// redirect to decide about, so demanding a disposition for it would mean triaging
// a URL the new site does not own. Components not yet migrated have no live
// versions and so fall out entirely, re-appearing as they migrate (the same
// coverage-gated scoping constructcheck uses).
//   pages            — [{ component, version, … }]; version '' = unversioned
//   migratedVersions — Map<component, Set<version>>
function scopeToMigrated (pages, migratedVersions) {
  return pages.filter((p) => {
    const versions = migratedVersions.get(p.component)
    return versions ? versions.has(p.version || '') : false
  })
}

// Classify every page into reachable / orphan given the resolved reachability
// sets. Inputs are plain:
//   pages    — [{ id, url, component, version, module, relative }]
//   navIds   — Set of page ids that appear in some navigation tree
//   startIds — Set of page ids that are a site/component landing page
//   linkedBy — Map<pageId, string[]> of referrer URLs (absent/empty => unlinked)
// A page is an orphan iff it is neither in nav nor a landing page. Its kind is
// `referenced` iff something links to it, else `unreachable`.
function classifyOrphans ({ pages, navIds, startIds, linkedBy }) {
  const orphans = []
  for (const p of pages) {
    if (navIds.has(p.id) || startIds.has(p.id)) continue
    const refs = (linkedBy && linkedBy.get(p.id)) || []
    orphans.push({ ...p, key: logicalKey(p), kind: refs.length ? 'referenced' : 'unreachable', refs })
  }
  return orphans
}

// Structural validation of the allowlist itself (independent of the corpus). A
// malformed allowlist must fail the gate: a bad disposition or a redirect with no
// destination means the triage decision is not actually captured. Returns an
// array of human-readable error strings ([] when clean).
function validateAllowlist (allow) {
  const errors = []
  if (allow == null || typeof allow !== 'object') return ['allow must be an object keyed by logical page']
  for (const [key, entry] of Object.entries(allow)) {
    if (entry == null || typeof entry !== 'object') { errors.push(`${key}: entry must be an object`); continue }
    if (!DISPOSITIONS.has(entry.disposition)) {
      errors.push(`${key}: disposition must be one of ${[...DISPOSITIONS].join(', ')} (got ${JSON.stringify(entry.disposition)})`)
    }
    if (entry.disposition === 'redirect' && !(typeof entry.to === 'string' && entry.to)) {
      errors.push(`${key}: disposition "redirect" requires a non-empty "to" target URL`)
    }
    if (entry.disposition !== 'redirect' && entry.to != null) {
      errors.push(`${key}: "to" is only meaningful for disposition "redirect"`)
    }
    // `nav` is the placement the converter injects for a keep-in-nav page (see
    // lib/dispositions + converter/lib/nav injectNavEntries). It must name the
    // sibling it follows, or the injection has nowhere to go; on any other
    // disposition it would be a silently ignored instruction.
    if (entry.nav != null) {
      if (entry.disposition !== 'keep-in-nav') {
        errors.push(`${key}: "nav" is only meaningful for disposition "keep-in-nav"`)
      } else if (typeof entry.nav !== 'object' || !(typeof entry.nav.after === 'string' && entry.nav.after)) {
        errors.push(`${key}: "nav" requires a non-empty "after" (the nav stem this entry follows)`)
      }
    }
  }
  return errors
}

// Apply the deny-by-default allowlist to the orphan set, keyed by logical page.
//   flagged — orphans whose logical page is NOT allowlisted (the gate fails on these)
//   allowed — orphans a human has triaged (grouped for the report)
//   staleKeys — allowlist keys that match no current orphan (a page that stopped
//               being an orphan; surfaced so the entry can be pruned, not fatal)
function applyAllowlist (orphans, allow) {
  const allowMap = allow || {}
  const flagged = []
  const allowed = []
  const matchedKeys = new Set()
  for (const o of orphans) {
    if (Object.prototype.hasOwnProperty.call(allowMap, o.key)) {
      matchedKeys.add(o.key)
      allowed.push(o)
    } else {
      flagged.push(o)
    }
  }
  const staleKeys = Object.keys(allowMap).filter((k) => !matchedKeys.has(k))
  return { flagged, allowed, staleKeys }
}

module.exports = {
  DISPOSITIONS,
  xrefTargets,
  includeTargets,
  logicalKey,
  scopeToMigrated,
  classifyOrphans,
  validateAllowlist,
  applyAllowlist,
}
