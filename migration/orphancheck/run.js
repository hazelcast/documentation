'use strict'

// The orphan gate. An orphan is a PUBLISHED page that no site-navigation tree
// links to. The fidelity, refs and construct gates all reason about a page the
// migration already knows about; none of them can tell you a page exists that
// nothing points at. This gate closes that hole from the nav side: it walks every
// navigation tree and every page's xrefs (through includes) and reports each page
// reachable from neither.
//
// Reachability is resolved over the WHOLE source corpus (every branch, so a nav
// or xref is never missed), but only pages the migration actually publishes are
// JUDGED — the migrated components at their live versions (lib/layout's
// NAV_SOURCES x versionsToProcess). Older branches are frozen as static HTML at
// their existing URLs outside this build, so an orphan that exists only there is
// not this site's page to triage; see scopeToMigrated in lib/reachability.js.
//
//   node orphancheck/run.js [--component cloud|operator|clc] [--playbook FILE]
//                           [--json]
//
// The allowlist (orphancheck/allowlist.json) is DENY-BY-DEFAULT, like
// constructcheck: an entry means a human has triaged that orphan and recorded
// what to do with it (keep-in-nav / keep-referenced / redirect+to / drop-404).
// It ships EMPTY, so every orphan is flagged until decided. Exit non-zero on any
// un-triaged orphan or a malformed allowlist: this is a gate, not a report.

const fs = require('node:fs')
const path = require('node:path')

const { buildContentCatalog } = require('../lib/catalog')
const { registerPageAliases } = require('../antora-extension/register-page-aliases')
const { NAV_SOURCES, versionsToProcess } = require('../lib/layout')
const {
  xrefTargets, includeTargets, scopeToMigrated, classifyOrphans, validateAllowlist, applyAllowlist,
} = require('./lib/reachability')

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  return {
    component: val('--component', null),
    playbook: val('--playbook', 'antora/index-playbook.yml'),
    json: has('--json'),
  }
}

// The live version set the gate judges, per migrated component. Single-sourced
// from lib/layout so the gate's scope tracks the migration itself: a component
// gains versions here the moment it is wired into NAV_SOURCES/VERSIONS. An
// unversioned component carries the one empty-string version Antora gives it.
function migratedVersionMap (component) {
  const components = component ? [component] : Object.keys(NAV_SOURCES)
  const map = new Map()
  for (const c of components) {
    if (!NAV_SOURCES[c]) {
      console.error(`[orphancheck] unknown component: ${c} (migrated: ${Object.keys(NAV_SOURCES).join(', ')})`)
      process.exit(2)
    }
    map.set(c, new Set(versionsToProcess(c).map((v) => (v.seg === null ? '' : v.seg))))
  }
  return map
}

const idOf = (file) => {
  const s = file.src
  return `${s.version || ''}@${s.component}:${s.module || ''}:${s.family}$${s.relative}`
}

function loadAllowlist () {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'allowlist.json'), 'utf8'))
  return raw.allow || {}
}

async function main () {
  const opts = parseArgs(process.argv)
  const allow = loadAllowlist()
  const allowErrors = validateAllowlist(allow)
  const migratedVersions = migratedVersionMap(opts.component)

  const { contentCatalog: cat, asciidocConfig } = await buildContentCatalog(opts.playbook, { silent: true })
  // Register aliases so an xref to a renamed page's OLD id resolves to its
  // current page (otherwise the target would look unreferenced). Same pass
  // index-pass uses.
  registerPageAliases(cat, asciidocConfig)

  // --- resolve reachability against the real catalog -------------------------
  const followAlias = (r) => (r && r.src && r.src.family === 'alias' ? (r.rel || null) : r)
  const resolveToPageId = (spec, ctx) => {
    let r
    try { r = cat.resolveResource(spec, ctx) } catch (e) { return null }
    r = followAlias(r)
    return r && r.src && r.src.family === 'page' ? idOf(r) : null
  }

  // Expand include:: directives (recursively, memoised) so xrefs inside included
  // partials count toward the including file. Cycle-guarded by depth + cache.
  const expandCache = new Map()
  const expand = (file, depth = 0) => {
    const key = idOf(file)
    if (expandCache.has(key)) return expandCache.get(key)
    if (depth > 10 || !file.contents) { const t = file.contents ? file.contents.toString() : ''; expandCache.set(key, t); return t }
    let txt = file.contents.toString()
    expandCache.set(key, txt) // provisional value breaks include cycles
    for (const spec of includeTargets(txt)) {
      let res
      try { res = cat.resolveResource(spec, file.src, 'partial') } catch (e) { res = null }
      if (res && res.contents) txt += '\n' + expand(res, depth + 1)
    }
    expandCache.set(key, txt)
    return txt
  }

  const pages = cat.findBy({ family: 'page' }).filter((p) => p.pub && p.pub.url)

  const navIds = new Set()
  for (const nav of cat.findBy({ family: 'nav' })) {
    for (const t of xrefTargets(expand(nav))) { const id = resolveToPageId(t, nav.src); if (id) navIds.add(id) }
  }

  const linkedBy = new Map()
  for (const p of pages) {
    for (const t of xrefTargets(expand(p))) {
      const id = resolveToPageId(t, p.src)
      if (id && id !== idOf(p)) { // a page linking only to itself is not "linked"
        if (!linkedBy.has(id)) linkedBy.set(id, new Set())
        linkedBy.get(id).add(p.pub.url)
      }
    }
  }

  const startIds = new Set()
  try { const s = followAlias(cat.getSiteStartPage()); if (s && s.src) startIds.add(idOf(s)) } catch (e) { /* no site start page */ }
  for (const c of cat.getComponents()) {
    for (const v of c.versions) {
      const cv = cat.getComponentVersion(c.name, v.version)
      const sp = cv && cv.url
      if (sp) { const pg = pages.find((p) => p.pub.url === sp); if (pg) startIds.add(idOf(pg)) }
    }
  }

  // --- scope + classify (pure) ----------------------------------------------
  // Reachability above was resolved over every branch; only the published set is
  // judged. (Resolution-only components — imdg, tutorials — are excluded for
  // free: they are not in NAV_SOURCES, so they have no live versions.)
  const rows = pages.map((p) => ({
    id: idOf(p), url: p.pub.url, component: p.src.component,
    version: p.src.version || '', module: p.src.module || 'ROOT', relative: p.src.relative,
  }))
  const inScope = scopeToMigrated(rows, migratedVersions)

  const linkedByIds = new Map([...linkedBy].map(([id, set]) => [id, [...set]]))
  const orphans = classifyOrphans({ pages: inScope, navIds, startIds, linkedBy: linkedByIds })
  const { flagged, allowed, staleKeys, staleScopes } = applyAllowlist(orphans, allow, opts.component, inScope)

  report(opts, migratedVersions, { scanned: inScope.length, orphans: orphans.length }, flagged, allowed, staleKeys, allowErrors, staleScopes)
  process.exit(flagged.length > 0 || allowErrors.length > 0 ? 1 : 0)
}

// Collapse per-version orphan instances into one row per logical page for the
// report (a page orphaned in six branches is one decision, not six).
function byLogicalPage (orphans) {
  const map = new Map()
  for (const o of orphans) {
    if (!map.has(o.key)) map.set(o.key, { key: o.key, component: o.component, kind: o.kind, versions: new Set(), refs: new Set() })
    const row = map.get(o.key)
    row.versions.add(o.version)
    if (o.kind === 'referenced') row.kind = 'referenced' // referenced in any branch => worth a link check
    o.refs.forEach((r) => row.refs.add(r))
  }
  return [...map.values()]
    .map((r) => ({ ...r, versions: [...r.versions].sort(), refs: [...r.refs].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

// Render a logical page's affected versions for the console. An unversioned
// component carries a single empty-string version; show that as "unversioned"
// rather than an empty "()".
const fmtVersions = (versions) => {
  const real = versions.filter((v) => v !== '')
  return real.length ? real.join(', ') : 'unversioned'
}

function report (opts, migratedVersions, counts, flagged, allowed, staleKeys, allowErrors, staleScopes = []) {
  const outFile = path.resolve('build/orphancheck-report.json')
  const flaggedPages = byLogicalPage(flagged)
  const allowedPages = byLogicalPage(allowed)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: {
      component: opts.component,
      versions: Object.fromEntries([...migratedVersions].map(([c, v]) => [c, [...v]])),
    },
    counts: {
      ...counts,
      flaggedPages: flaggedPages.length,
      allowedPages: allowedPages.length,
      unreachable: flaggedPages.filter((p) => p.kind === 'unreachable').length,
      referenced: flaggedPages.filter((p) => p.kind === 'referenced').length,
    },
    allowlistErrors: allowErrors,
    staleAllowlistKeys: staleKeys,
    staleAllowlistScopes: staleScopes,
    flagged: flaggedPages,
    allowed: allowedPages,
  }, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify({ counts, flagged: flaggedPages, allowlistErrors: allowErrors, staleAllowlistKeys: staleKeys })); return }

  const scope = opts.component ? `component=${opts.component}` : 'all migrated components'
  // Name the judged versions outright: the gate is silent about frozen branches
  // by design, and that is only trustworthy if the scope is visible.
  const vers = [...migratedVersions]
    .map(([c, v]) => `${c}=${[...v].join(',') || 'unversioned'}`).join(' | ')
  console.log(`\n[orphancheck] ${scope}`)
  console.log(`[orphancheck] migrated versions judged: ${vers}`)
  console.log(`[orphancheck] pages scanned: ${counts.scanned} | orphan pages: ${flaggedPages.length + allowedPages.length} | triaged (allowlisted): ${allowedPages.length} | flagged: ${flaggedPages.length}`)

  if (allowErrors.length) {
    console.log(`\n[orphancheck] ✗ allowlist.json is malformed (${allowErrors.length}):`)
    for (const e of allowErrors) console.log(`      ${e}`)
  }
  if (staleKeys.length) {
    console.log(`\n[orphancheck] ⚠ ${staleKeys.length} stale allowlist entr${staleKeys.length === 1 ? 'y' : 'ies'} (page no longer an orphan — prune):`)
    for (const k of staleKeys) console.log(`      ${k}`)
  }
  // A narrowed entry that has drifted: it still triages the page somewhere, but
  // names a version the page is in scope in and no longer orphaned in. Surfaced
  // separately from a wholly stale key because the fix is different -- trim the
  // `versions` list, do not delete the entry.
  if (staleScopes.length) {
    console.log(`\n[orphancheck] ⚠ ${staleScopes.length} allowlist entr${staleScopes.length === 1 ? 'y names a version' : 'ies name versions'} the page is no longer an orphan in (trim "versions"):`)
    for (const { key, versions } of staleScopes) console.log(`      ${key}    (${versions.join(', ')})`)
  }

  if (!flaggedPages.length) {
    if (!allowErrors.length) console.log('[orphancheck] every orphan is triaged & allowlisted. ✓')
    console.log(`\n[orphancheck] report -> ${path.relative(process.cwd(), outFile)}`)
    return
  }

  const unreachable = flaggedPages.filter((p) => p.kind === 'unreachable')
  const referenced = flaggedPages.filter((p) => p.kind === 'referenced')
  console.log(`\n[orphancheck] ✗ ${flaggedPages.length} un-triaged orphan page(s) — decide a disposition and add to allowlist.json:`)

  const byComp = (rows) => {
    const m = new Map()
    for (const r of rows) { if (!m.has(r.component)) m.set(r.component, []); m.get(r.component).push(r) }
    return [...m].sort()
  }
  if (unreachable.length) {
    console.log(`\n  UNREACHABLE — not in nav, nothing links to them (${unreachable.length}):`)
    for (const [comp, rows] of byComp(unreachable)) {
      console.log(`    [${comp}]`)
      for (const r of rows) console.log(`      ${r.key}    (${fmtVersions(r.versions)})`)
    }
  }
  if (referenced.length) {
    console.log(`\n  REFERENCED — not in nav, but reachable via xref; dropping needs a redirect or the referrers fixed (${referenced.length}):`)
    for (const [comp, rows] of byComp(referenced)) {
      console.log(`    [${comp}]`)
      for (const r of rows) {
        console.log(`      ${r.key}    (${fmtVersions(r.versions)})`)
        for (const ref of r.refs.slice(0, 4)) console.log(`          <- ${ref}`)
        if (r.refs.length > 4) console.log(`          <- … ${r.refs.length - 4} more`)
      }
    }
  }
  console.log(`\n[orphancheck] report -> ${path.relative(process.cwd(), outFile)}`)
}

main().catch((err) => { console.error(err); process.exit(2) })
