'use strict'

// The orphan gate. An orphan is a PUBLISHED page that no site-navigation tree
// links to. The fidelity, refs and construct gates all reason about a page the
// migration already knows about; none of them can tell you a page exists that
// nothing points at. This gate closes that hole from the nav side: it aggregates
// the whole source corpus (every component, EVERY branch — orphan-ness is a
// source-side structural fact, independent of what has been converted yet),
// walks every navigation tree and every page's xrefs (through includes), and
// reports each page reachable from neither.
//
//   node orphancheck/run.js [--component cloud|hazelcast|…] [--playbook FILE]
//                           [--include-resolution-only] [--json]
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
const {
  xrefTargets, includeTargets, classifyOrphans, validateAllowlist, applyAllowlist,
} = require('./lib/reachability')

// Components built only so cross-component xrefs into them resolve to the right
// URLs (see the migration README). They are not emitted as pages, so their
// orphans are moot; excluded unless --include-resolution-only is passed.
const RESOLUTION_ONLY = new Set(['imdg', 'tutorials'])

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  return {
    component: val('--component', null),
    playbook: val('--playbook', 'antora/index-playbook.yml'),
    includeResolutionOnly: has('--include-resolution-only'),
    json: has('--json'),
  }
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
  const inScope = pages
    .filter((p) => (opts.component ? p.src.component === opts.component
      : opts.includeResolutionOnly || !RESOLUTION_ONLY.has(p.src.component)))
    .map((p) => ({
      id: idOf(p), url: p.pub.url, component: p.src.component,
      version: p.src.version || '', module: p.src.module || 'ROOT', relative: p.src.relative,
    }))

  const linkedByIds = new Map([...linkedBy].map(([id, set]) => [id, [...set]]))
  const orphans = classifyOrphans({ pages: inScope, navIds, startIds, linkedBy: linkedByIds })
  const { flagged, allowed, staleKeys } = applyAllowlist(orphans, allow)

  report(opts, { scanned: inScope.length, orphans: orphans.length }, flagged, allowed, staleKeys, allowErrors)
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

function report (opts, counts, flagged, allowed, staleKeys, allowErrors) {
  const outFile = path.resolve('build/orphancheck-report.json')
  const flaggedPages = byLogicalPage(flagged)
  const allowedPages = byLogicalPage(allowed)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: { component: opts.component, includeResolutionOnly: opts.includeResolutionOnly },
    counts: {
      ...counts,
      flaggedPages: flaggedPages.length,
      allowedPages: allowedPages.length,
      unreachable: flaggedPages.filter((p) => p.kind === 'unreachable').length,
      referenced: flaggedPages.filter((p) => p.kind === 'referenced').length,
    },
    allowlistErrors: allowErrors,
    staleAllowlistKeys: staleKeys,
    flagged: flaggedPages,
    allowed: allowedPages,
  }, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify({ counts, flagged: flaggedPages, allowlistErrors: allowErrors, staleAllowlistKeys: staleKeys })); return }

  const scope = opts.component ? `component=${opts.component}`
    : `all migrated components${opts.includeResolutionOnly ? ' + resolution-only' : ''}`
  console.log(`\n[orphancheck] ${scope}`)
  console.log(`[orphancheck] pages scanned: ${counts.scanned} | orphan pages: ${flaggedPages.length + allowedPages.length} | triaged (allowlisted): ${allowedPages.length} | flagged: ${flaggedPages.length}`)

  if (allowErrors.length) {
    console.log(`\n[orphancheck] ✗ allowlist.json is malformed (${allowErrors.length}):`)
    for (const e of allowErrors) console.log(`      ${e}`)
  }
  if (staleKeys.length) {
    console.log(`\n[orphancheck] ⚠ ${staleKeys.length} stale allowlist entr${staleKeys.length === 1 ? 'y' : 'ies'} (page no longer an orphan — prune):`)
    for (const k of staleKeys) console.log(`      ${k}`)
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
