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

module.exports = { buildAnchorIndex, loadAnchorIndex, convertedAnchorLookup }
