'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Stages the example files the tutorial pages import. Same principle as
// plugins/openapi-specs: the files are NEVER copied into this repo.
//
// A tutorial's examples are the guide repo's RUNNABLE project files -- each
// hazelcast-guides repo symlinks `src/`, `client/`, `pom.xml` and friends into
// Antora's examples dir, and that repo's own CI compiles them while Dependabot
// keeps their dependencies current. A committed copy here would be a second,
// unmaintained fork of code that already has a maintained home, and it would put
// runnable third-party code inside the site tree where webpack walks it.
//
// So tutorials/examples.json holds only REFERENCES -- repo, commit, path and a
// hash of the bytes -- and this plugin fetches each one from the pinned commit
// into a gitignored staging dir that the pages import out of (`@site/…`).
// Because the pin is a commit SHA the bytes are immutable, so a file already
// staged at that SHA is never re-fetched.
//
// A failed fetch, or a hash that does not match, FAILS THE BUILD. Publishing a
// page whose code block silently differs from the code the migration verified is
// worse than not publishing it.

const STAGING_DIR = '.tutorial-examples'
// No `.json` extension: the staging dir is covered by the example-attributes
// webpack rule, and a cache.json in there would be pulled through the loader
// chain as if it were an example.
const CACHE_FILE = '.fetch-cache'
const MANIFEST = path.join('tutorials', 'examples.json')
const CONCURRENCY = 8

async function fetchFile ({ repo, sha, path: filePath }, token) {
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${filePath.split('/').map(encodeURIComponent).join('/')}`
  const headers = { 'User-Agent': 'hazelcast-docs' }
  // Public repos, so a token is optional -- it only raises the rate limit.
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${repo}@${sha.slice(0, 8)}/${filePath}`)
  }
  // NOT response.text(): that decodes per WHATWG, which STRIPS a leading UTF-8
  // BOM. Four of the guides' C# examples start with one, so text() would stage
  // bytes that differ from the file the converter matched -- silently, but for
  // the hash check below.
  return Buffer.from(await response.arrayBuffer()).toString('utf8')
}

async function pool (items, limit, worker) {
  const queue = [...items]
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await worker(next)
  })
  await Promise.all(runners)
}

// Remove anything under the staging dir this run did not write, so a file a page
// stops referencing cannot linger and keep being imported from a stale copy.
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
  const manifestPath = path.join(siteDir, MANIFEST)

  return {
    name: 'tutorial-examples',

    async loadContent () {
      if (!fs.existsSync(manifestPath)) return
      const { files } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (!files || !files.length) return

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
        // The pin is a commit, so the bytes cannot have changed: a file already
        // staged from this SHA is current by construction.
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
