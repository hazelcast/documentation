'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Stages the example files the tutorial pages import, fetched from pinned commits into a gitignored staging
// dir (as plugins/openapi-specs); never committed. `<component>/examples.json` holds only references (repo,
// commit, path, sha256). The pin is a commit SHA, so an already-staged file is never re-fetched.
// A failed fetch or hash mismatch fails the build.

const STAGING_DIR = '.tutorial-examples'
// No `.json` extension: the example-attributes webpack rule covers this dir and would treat a cache.json as an example.
const CACHE_FILE = '.fetch-cache'
const CONCURRENCY = 8

// Any top-level `<component>/examples.json` declares example references; discovered, not named. Versioned trees never hold one.
function manifestFiles (siteDir) {
  return fs.readdirSync(siteDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => path.join(siteDir, e.name, 'examples.json'))
    .filter((f) => fs.existsSync(f))
}

// Merges manifests into one fetch list keyed by id (namespaced by source repo), so shared files fetch once.
// Two manifests disagreeing on a file's bytes is a conflict and fails.
function mergeManifests (files) {
  const byId = new Map()
  for (const file of files) {
    const { files: entries } = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const entry of entries || []) {
      const prev = byId.get(entry.id)
      if (prev && prev.sha256 !== entry.sha256) {
        throw new Error(`[tutorial-examples] ${entry.id} is declared by two manifests with different content ` +
          `(${prev.sha256.slice(0, 12)} vs ${entry.sha256.slice(0, 12)}); one would overwrite the other`)
      }
      if (!prev) byId.set(entry.id, entry)
    }
  }
  return [...byId.values()]
}

async function fetchFile ({ repo, sha, path: filePath }, token) {
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${filePath.split('/').map(encodeURIComponent).join('/')}`
  const headers = { 'User-Agent': 'hazelcast-docs' }
  // Public repos, so the token only raises the rate limit.
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${repo}@${sha.slice(0, 8)}/${filePath}`)
  }
  // Not response.text(): it strips a leading UTF-8 BOM, which would stage bytes that fail the hash check.
  return Buffer.from(await response.arrayBuffer()).toString('utf8')
}

async function pool (items, limit, worker) {
  const queue = [...items]
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await worker(next)
  })
  await Promise.all(runners)
}

// Remove anything under the staging dir this run did not write, so dropped files aren't imported stale.
function pruneStale (stagingDir, keep) {
  if (!fs.existsSync(stagingDir)) return
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
      } else if (!keep.has(full)) {
        fs.rmSync(full)
      }
    }
  }
  walk(stagingDir)
}

module.exports = function tutorialExamplesPlugin (context) {
  const siteDir = context.siteDir
  const stagingDir = path.join(siteDir, STAGING_DIR)
  const cachePath = path.join(stagingDir, CACHE_FILE)

  return {
    name: 'tutorial-examples',

    async loadContent () {
      const manifests = manifestFiles(siteDir)
      if (!manifests.length) return
      const files = mergeManifests(manifests)
      if (!files.length) return

      fs.mkdirSync(stagingDir, { recursive: true })
      let cache = {}
      try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) } catch { /* first run */ }

      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null
      const keep = new Set([cachePath])
      const errors = []
      let fetched = 0
      let cached = 0

      await pool(files, CONCURRENCY, async (entry) => {
        const target = path.join(stagingDir, entry.id)
        keep.add(target)
        // The pin is a commit, so a file already staged from this SHA is current.
        if (cache[entry.id] === entry.sha && fs.existsSync(target)) { cached++; return }
        try {
          const content = await fetchFile(entry, token)
          if (entry.sha256) {
            const got = crypto.createHash('sha256').update(content).digest('hex')
            if (got !== entry.sha256) {
              throw new Error(`content hash mismatch for ${entry.repo}/${entry.path} (expected ${entry.sha256.slice(0, 12)}, got ${got.slice(0, 12)})`)
            }
          }
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, content, 'utf8')
          cache[entry.id] = entry.sha
          fetched++
        } catch (err) {
          errors.push(`  ${entry.id}: ${err.message}`)
        }
      })

      if (errors.length) {
        throw new Error(`[tutorial-examples] ${errors.length} example file(s) could not be staged:\n${errors.join('\n')}`)
      }

      pruneStale(stagingDir, keep)
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n')
      console.log(`[tutorial-examples] ${files.length} example file(s) staged (${fetched} fetched, ${cached} already current) -> ${STAGING_DIR}/`)
    },
  }
}
