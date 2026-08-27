'use strict'

// Shared read access to the orphan triage decisions in orphancheck/allowlist.json.
//
// An orphan decision is not just a note for the gate — it is an instruction to
// the build: `drop-404` and `redirect` mean stop publishing the page (the
// latter also emits a client redirect from its URL), `keep-in-nav` means put
// it in the nav it is missing from. Reading the decision from the same file the
// human wrote it in keeps the two from drifting, which is the failure mode worth
// designing against: a gate reporting a page as dropped while the converter
// happily keeps emitting it, or a nav fix that lives only in a hand-edit and is
// silently reverted by the next conversion run.
//
// Keys are the logical page keys orphancheck reports (`{component}[:{module}]/
// {relative-without-.adoc}`), so one entry covers a page across every version.

const fs = require('node:fs')
const path = require('node:path')

const { logicalKey } = require('../orphancheck/lib/reachability')

const ALLOWLIST = path.join(__dirname, '..', 'orphancheck', 'allowlist.json')

function loadDispositions (file = ALLOWLIST) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return new Map(Object.entries(raw.allow || {}))
}

// The logical key of a manifest-shaped resource ({component, module, relative}).
const keyOf = (r) => logicalKey({ component: r.component, module: r.module, relative: r.relative })

// Pages the migration deliberately does not publish. TWO dispositions land
// here, for the same reason: the decision only takes effect if no .mdx ever
// reaches the site. `drop-404` is dead or empty and its URL is allowed to 404;
// `redirect` keeps its URL alive with a client redirect to `to`, and NOT
// emitting the page is precisely what lets that redirect fire (a real page at
// the URL would win over it). Returned as a predicate so callers (converter,
// gates) all ask the same question the same way -- the converter to skip
// emitting, the gates to keep the page out of scope entirely rather than
// counting it as "not yet converted" (which would quietly overstate the work
// still to do).
const UNPUBLISHED = new Set(['drop-404', 'redirect'])

function isUnpublished (dispositions, resource) {
  const e = dispositions.get(keyOf(resource))
  return !!(e && UNPUBLISHED.has(e.disposition))
}

// The redirect target recorded for a page, or null. The stored `to` is
// COMPONENT/VERSION-RELATIVE (e.g. "/maintain-cluster/rest-api"): one allowlist
// key covers the page in EVERY version it exists in, so a fully-qualified URL
// could only ever be correct for one of them. Resolving it against the page's
// own URL base -- and refusing a target that is not itself a published page --
// is the converter's job (collectRedirects), which is where the URL space and
// the live-version set are known.
function redirectTo (dispositions, resource) {
  const e = dispositions.get(keyOf(resource))
  return e && e.disposition === 'redirect' ? e.to : null
}

// The URLs of every page the migration does not publish, for gates that see
// pages by URL rather than by manifest record (fidelity pairs golden HTML files
// to converted output). Same decision as isUnpublished, keyed the way those
// callers can use it.
function unpublishedUrls (dispositions, manifest) {
  const urls = new Set()
  for (const r of (manifest.resources || [])) {
    if (r.family === 'page' && r.url && isUnpublished(dispositions, r)) urls.add(r.url)
  }
  return urls
}

// A page URL's component/version base: its own URL minus the module/relative
// tail it was built from -- "/hazelcast/5.8-snapshot" for
// "/hazelcast/5.8-snapshot/clients/rest", "/cloud" for "/cloud/install".
// Derived by subtracting the tail rather than by counting path segments, so it
// is right for unversioned components and ROOT-module pages alike. null if the
// URL does not end in its own tail (a page whose URL was not built from its
// coordinate, which we must not guess at).
function urlBase (r) {
  const mod = r.module && r.module !== 'ROOT' ? `${r.module}/` : ''
  const tail = `/${mod}${String(r.relative || '').replace(/\.adoc$/, '')}`
  return String(r.url || '').endsWith(tail) ? r.url.slice(0, r.url.length - tail.length) : null
}

// Trailing slash off (docusaurus.config `trailingSlash: false`), so a redirect
// path must have no trailing slash -- except the site root.
const normalizeRoute = (url) => (url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url)

// The {from, to} pairs the `redirect` orphan decisions contribute to
// src/redirects.ts. The page itself is not emitted (isUnpublished), so without
// these its URL would simply 404: the pair IS what "redirect" means.
//
// `isLive(r)` is the caller's "this resource becomes a real route" test (its
// component is converted and its version is one that is built). The stored `to`
// is resolved against the page's OWN url base, so each version redirects within
// itself and never across a version boundary -- which is the whole reason the
// allowlist stores it component/version-relative.
//
// Fails closed on a target that is not itself a published page: the
// client-redirects plugin fails the build on a `to` that is not a real route,
// and a `to` naming another withheld page would be a redirect to a 404. Better
// to say which allowlist entry is wrong than to ship either.
function redirectPairs (dispositions, manifest, isLive) {
  const resources = manifest.resources || []
  const published = new Set()
  for (const r of resources) {
    if (r.family !== 'page' || !r.url || !isLive(r)) continue
    if (!isUnpublished(dispositions, r)) published.add(normalizeRoute(r.url))
  }
  const pairs = []
  for (const r of resources) {
    if (r.family !== 'page' || !r.url || !isLive(r)) continue
    const rel = redirectTo(dispositions, r)
    if (!rel) continue
    const base = urlBase(r)
    if (base == null) {
      throw new Error(`redirect for ${r.url}: cannot derive its component/version base from module=${r.module} relative=${r.relative}`)
    }
    const to = normalizeRoute(base + rel)
    if (!published.has(to)) {
      throw new Error(`redirect for ${r.url}: target ${to} is not a published page -- check the "to" in orphancheck/allowlist.json, which is relative to the component/version (e.g. "/maintain-cluster/rest-api")`)
    }
    const from = normalizeRoute(r.url)
    if (from !== to) pairs.push({ from, to })
  }
  return pairs
}

// Nav entries the migration ADDS for a component: a `keep-in-nav` orphan whose
// entry carries a `nav.after` placement (the nav key of the sibling it follows).
// The source nav.adoc is left untouched; the injection happens in-memory during
// conversion, so the fix is reproducible on every run and reviewable as data.
// Returns [{ key, after }], where both are the converter's module-qualified nav
// keys (`module:stem`, bare for ROOT — Antora's own coordinate). A logical key's
// `module/` segment becomes the `module:` coordinate: the injected line is nav
// AsciiDoc, so it has to name the module the way an xref does, and a bare stem
// would resolve against ROOT and point at nothing.
function navInjectionsFor (dispositions, component) {
  const out = []
  for (const [key, entry] of dispositions) {
    if (!entry || entry.disposition !== 'keep-in-nav' || !entry.nav) continue
    const [comp, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (comp !== component) continue
    out.push({ key: navKey(rest), after: entry.nav.after })
  }
  return out
}

// A logical key's page part (`[module/]relative`) -> the nav coordinate
// (`[module:]relative`). ROOT-module pages carry no module segment in either form.
const navKey = (rest) => {
  const i = rest.indexOf('/')
  return i === -1 ? rest : `${rest.slice(0, i)}:${rest.slice(i + 1)}`
}

module.exports = {
  loadDispositions, keyOf, isUnpublished, redirectTo, unpublishedUrls,
  urlBase, redirectPairs, navInjectionsFor, ALLOWLIST,
}
