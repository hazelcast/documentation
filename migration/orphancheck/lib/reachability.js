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
    // A redirect needs EXACTLY ONE destination, in one of two forms.
    //
    // `to` is the common case and is COMPONENT/VERSION-RELATIVE ("/maintain-cluster/
    // rest-api"): one allowlist key covers the page in every version it exists in,
    // so the destination has to be resolved against each version's own URL base.
    //
    // `toUrl` is the cross-component case, and is an ABSOLUTE site route
    // ("/clc/5.5.1/overview"). A page whose only sensible destination lives in
    // ANOTHER component cannot use `to`: the other component has its own version
    // line, so there is no base to resolve against. It is a separate field rather
    // than an absolute value in `to` because both forms start with "/" and nothing
    // in the string distinguishes them -- "/clc/…" is a component-relative path as
    // readily as an absolute one -- so inferring the form would silently
    // misresolve. Being a distinct key also keeps the two visibly different in the
    // file, which is the point: `toUrl` pins a version in another component and so
    // has to be revisited when that component's live set moves, where `to` never
    // does.
    const dests = ['to', 'toUrl'].filter((f) => entry[f] != null)
    if (entry.disposition === 'redirect') {
      if (!dests.length) {
        errors.push(`${key}: disposition "redirect" requires a destination: "to" (component/version-relative) or "toUrl" (absolute, cross-component)`)
      } else if (dests.length > 1) {
        errors.push(`${key}: "to" and "toUrl" are alternatives -- give exactly one`)
      } else if (!(typeof entry[dests[0]] === 'string' && entry[dests[0]])) {
        errors.push(`${key}: "${dests[0]}" must be a non-empty string`)
      } else if (dests[0] === 'toUrl' && !entry.toUrl.startsWith('/')) {
        errors.push(`${key}: "toUrl" must be an absolute site route starting with "/" (got ${JSON.stringify(entry.toUrl)})`)
      }
    } else if (dests.length) {
      errors.push(`${key}: "${dests.join('"/"')}" is only meaningful for disposition "redirect"`)
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
    // `versions` NARROWS the entry to the version segments named. Absent, the
    // entry covers every version -- right whenever a page is an orphan wherever
    // it exists, which is most of them. Present, it says the page's orphan-ness
    // differs BETWEEN versions, which is a fact about the source, not a
    // preference: Platform 5.4/5.3 nav via per-module partials and still list
    // pages the flat 5.5+ nav dropped. An empty list would silently disable the
    // entry, so it is rejected rather than read as "nowhere".
    if (entry.versions != null) {
      if (!Array.isArray(entry.versions) || !entry.versions.length) {
        errors.push(`${key}: "versions" must be a non-empty array of version segments (e.g. ["5.5", "5.6"])`)
      } else if (!entry.versions.every((v) => typeof v === 'string' && v)) {
        errors.push(`${key}: "versions" entries must be non-empty strings`)
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
//   staleScopes — allowlist entries whose `versions` names a version the page is
//               in scope in but NOT an orphan in (the narrowing has drifted past
//               what the sources say; surfaced, not fatal, like staleKeys)
//
// Matching is PER VERSION: an entry narrowed with `versions` clears the orphan
// only in the versions it names. Deny-by-default therefore applies per version
// too -- the same page orphaned in a version the entry does not name is flagged
// as untriaged, so narrowing an entry can only surface work, never hide it.
//
// `inScopePages` (optional) is every page the run judged, not just the orphans.
// It is what makes staleScopes decidable: without the full page set, a version
// naming a page that is no longer an orphan is indistinguishable from one naming
// a page that no longer exists.
function applyAllowlist (orphans, allow, component, inScopePages = null) {
  const allowMap = allow || {}
  const flagged = []
  const allowed = []
  const matchedKeys = new Set()
  const covers = (entry, o) => !entry.versions || entry.versions.includes(o.version)
  for (const o of orphans) {
    const entry = Object.prototype.hasOwnProperty.call(allowMap, o.key) ? allowMap[o.key] : null
    if (entry && covers(entry, o)) {
      matchedKeys.add(o.key)
      allowed.push(o)
    } else {
      flagged.push(o)
    }
  }
  // A `versions` list is hand-maintained, so it drifts: a version named there
  // may stop being one the page is orphaned in. Report that rather than leaving a
  // decision quietly applying to nothing -- this is the failure mode explicit
  // scoping trades for, and the gate is the only thing that can catch it.
  const orphanVersionsByKey = new Map()
  for (const o of orphans) {
    if (!orphanVersionsByKey.has(o.key)) orphanVersionsByKey.set(o.key, new Set())
    orphanVersionsByKey.get(o.key).add(o.version)
  }
  const inScopeVersionsByKey = new Map()
  for (const p of inScopePages || []) {
    const k = logicalKey(p)
    if (!inScopeVersionsByKey.has(k)) inScopeVersionsByKey.set(k, new Set())
    inScopeVersionsByKey.get(k).add(p.version)
  }
  const staleScopes = []
  if (inScopePages) {
    for (const [key, entry] of Object.entries(allowMap)) {
      if (!entry || !entry.versions) continue
      if (component && !key.startsWith(component + ':')) continue
      const inScopeVersions = inScopeVersionsByKey.get(key)
      if (!inScopeVersions) continue // page not in this run's scope at all
      const orphaned = orphanVersionsByKey.get(key) || new Set()
      const dead = entry.versions.filter((v) => inScopeVersions.has(v) && !orphaned.has(v))
      if (dead.length) staleScopes.push({ key, versions: dead })
    }
  }
  // Staleness is only judgeable for keys this run could have MATCHED. A
  // `--component X` run sees no other component's pages, so every other
  // component's entry would report as stale -- five false "prune me" lines on a
  // scoped run, which is exactly how a reader learns to skim past the warning and
  // miss a real one. Same scope rule the fidelity and refcheck accept-lists use.
  const staleKeys = Object.keys(allowMap)
    .filter((k) => !matchedKeys.has(k))
    .filter((k) => !component || k.startsWith(component + ':'))
  return { flagged, allowed, staleKeys, staleScopes }
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
