'use strict'

// Which pinned repo holds a file, for an UNVERSIONED component assembled from
// several repos: tutorials from 58 (one guide per repo, plus the landing page and
// cloud-docs/tutorials), cloud from 2 (cloud-docs + the maven plugin's page),
// templates from 2. lib/layout.js names ONE mirror per component, so a file in
// any other repo could not be opened, and every walk over page sources skipped
// it without a word. Read from the lockfile, so this covers exactly the repos
// Antora assembled, at the SHAs it assembled them from.
//
// Only components the migration reads: the migrated set and the read-only
// sources. imdg and jdbc-driver are in the lockfile too, but are resolution-only.
// Versioned components are left to layout.refFor, which picks a branch per seg.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { isVersioned, READ_ONLY_SOURCES } = require('./layout')
const { MIGRATED_COMPONENTS } = require('./live-set')

const READ = new Set([...MIGRATED_COMPONENTS, ...Object.keys(READ_ONLY_SOURCES)])

const LOCKFILE = path.join(__dirname, '..', 'build', 'manifest', 'lockfile.json')

let sources = null
function lockfileSources () {
  if (!sources) sources = fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')).sources : []
  return sources
}

const hasLockedSources = (component) =>
  READ.has(component) && !isVersioned(component) && lockfileSources().some((s) => s.descriptor === component)

const FAMILY_PATH = /^modules\/[^/]+\/(pages|partials|examples)\//

const mirrorDir = (sourcesDir, url) => path.join(sourcesDir, path.basename(url).replace(/(\.git)?$/, '.git'))

// component -> { files: Map(rel -> owner), links: [{ rel, owner }] }, where `rel`
// is relative to the source's start path (`modules/ROOT/pages/x.adoc`). Symlinks
// are indexed as well as files: the guide repos link `src/` and friends into
// their examples dir, and a path THROUGH a link belongs to the repo holding it.
const indexes = new Map()
function indexFor (component, sourcesDir) {
  const key = `${sourcesDir}\u0000${component}`
  if (indexes.has(key)) return indexes.get(key)
  const files = new Map()
  const links = []
  for (const s of lockfileSources().filter((x) => x.descriptor === component)) {
    const owner = { repoDir: mirrorDir(sourcesDir, s.url), ref: s.refhash, startPath: s.startPath }
    // Throws on a mirror missing the pinned SHA: a source that cannot be read must
    // not quietly drop out of the walk again.
    const out = execFileSync('git', ['-C', owner.repoDir, 'ls-tree', '-r', s.refhash, '--', s.startPath],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+) \w+ \w+\t(.+)$/)
      if (!m) continue
      const rel = m[2].slice(s.startPath.length + 1)
      // Only the family dirs, where Antora itself rejects a duplicate; antora.yml
      // and nav files legitimately exist once per repo.
      if (!FAMILY_PATH.test(rel)) continue
      if (m[1] === '120000') { links.push({ rel, owner }); continue }
      const prev = files.get(rel)
      if (prev) throw new Error(`[locked-sources] ${component}: ${rel} is in both ${prev.repoDir} and ${owner.repoDir}`)
      files.set(rel, owner)
    }
  }
  const idx = { files, links }
  indexes.set(key, idx)
  return idx
}

// Every pinned repo root a component is assembled from, as { repoDir, ref,
// modulesRoot } -- for a walk over the whole component rather than one file.
const lockedRoots = (component, sourcesDir) => hasLockedSources(component)
  ? lockfileSources().filter((s) => s.descriptor === component).map((s) => ({
    repoDir: mirrorDir(sourcesDir, s.url), ref: s.refhash, modulesRoot: path.posix.join(s.startPath, 'modules'),
  }))
  : []

// { repoDir, ref, repoPath } for `rel` in `component`, or null.
function locateLocked (component, rel, sourcesDir) {
  const { files, links } = indexFor(component, sourcesDir)
  let owner = files.get(rel)
  if (!owner) {
    const link = links.find((l) => rel === l.rel || rel.startsWith(l.rel + '/'))
    owner = link && link.owner
  }
  if (!owner) return null
  return { repoDir: owner.repoDir, ref: owner.ref, repoPath: path.posix.join(owner.startPath, rel) }
}

module.exports = { hasLockedSources, locateLocked, lockedRoots }
