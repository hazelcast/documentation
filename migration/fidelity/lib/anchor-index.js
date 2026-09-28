'use strict'

// Anchor index: site URL -> Set of anchor ids the page defines. Built from the
// golden pages, which are the fidelity reference: in a faithful migration a
// page's heading ids do not change, so the golden anchors are what an internal
// "#frag" link must resolve against -- including links whose target page is not
// yet converted. Cached to disk keyed by the snapshot lockfile so it is built
// once per baseline, not on every run.

const fs = require('node:fs')
const path = require('node:path')
const cheerio = require('cheerio')

const { goldenPages, readGolden, resolveConverted } = require('./pairing')
const { isLiveResource } = require('../../lib/live-set')

function buildAnchorIndex (goldenDir) {
  const index = new Map()
  for (const p of goldenPages(goldenDir)) {
    const $ = cheerio.load(readGolden(p.file), null, false)
    const ids = new Set()
    $('[id]').each((_, el) => ids.add($(el).attr('id')))
    $('a[name]').each((_, el) => ids.add($(el).attr('name')))
    index.set(p.url, ids)
  }
  return index
}

// Load from cache if the cache was built for the current lockfile key; else
// rebuild and rewrite the cache. Serialized as url -> array.
function loadAnchorIndex (goldenDir, lockfileKey, cacheFile) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (cached.lockfileKey === lockfileKey) {
        return new Map(Object.entries(cached.anchors).map(([u, a]) => [u, new Set(a)]))
      }
    } catch { /* fall through to rebuild */ }
  }
  const index = buildAnchorIndex(goldenDir)
  if (cacheFile) {
    const anchors = Object.fromEntries([...index].map(([u, s]) => [u, [...s]]))
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ lockfileKey, anchors }))
  }
  return index
}

// The converted side: url -> Set of ids on OUR built page, or null when the URL
// has no converted page (not migrated yet, or deliberately unpublished). Read
// from the WHOLE built page, not the main fragment -- a browser resolves "#frag"
// against any id on the page. Lazy and memoized: only link targets are parsed.
// Not cached to disk, since the build changes without the lockfile changing.
function convertedAnchorLookup (buildDir) {
  const memo = new Map()
  return (url) => {
    if (memo.has(url)) return memo.get(url)
    const file = resolveConverted(buildDir, url)
    let ids = null
    if (file) {
      const $ = cheerio.load(fs.readFileSync(file, 'utf8'))
      ids = new Set()
      $('[id]').each((_, el) => ids.add($(el).attr('id')))
      $('a[name]').each((_, el) => ids.add($(el).attr('name')))
    }
    memo.set(url, ids)
    return ids
  }
}

// Does a link target exist in OUR build? The manifest says what Antora served;
// this says what we serve. Judged only for a target in a LIVE version of a
// migrated component (lib/live-set.js): a link into a version we do not migrate
// (MC 5.3, IMDG 4.2, ...) can only ever work once frozen versions are hosted, so
// it is tallied in `outside` (component@version -> link count) for the report
// rather than failed. A client-redirect file counts as built -- that is how a
// page alias or a redirected orphan is served.
function builtTargetLookup (buildDir, manifest, live) {
  const byUrl = new Map()
  for (const r of manifest.resources || []) if (r.url) byUrl.set(r.url, r)
  const memo = new Map()
  const exists = (u) => {
    if (!memo.has(u)) memo.set(u, !!resolveConverted(buildDir, u))
    return memo.get(u)
  }
  const outside = new Map()
  const isBuilt = (canonical) => {
    const r = byUrl.get(canonical)
    if (!r || (r.family !== 'page' && r.family !== 'alias')) return true
    if (!isLiveResource(live, r)) {
      const k = `${r.component}@${r.version || ''}`
      outside.set(k, (outside.get(k) || 0) + 1)
      return true
    }
    return exists(canonical)
  }
  return { isBuilt, outside }
}

module.exports = { buildAnchorIndex, loadAnchorIndex, convertedAnchorLookup, builtTargetLookup }
