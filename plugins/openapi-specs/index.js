'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Globby } = require('@docusaurus/utils')

const substitute = require('../lib/substitute-attributes')
const { specFileName, specUrlFor } = require('../lib/api-spec-url')
const { menuAnchors, anchorCollisions } = require('../lib/api-anchors')

// Stages the OpenAPI specs that <ApiReference> pages render. The specs live in private product repos, so the
// site must serve them itself. They are fetched on every build into a gitignored staging dir (a second
// `staticDirectories` entry in docusaurus.config.ts), never committed.
// A page declares a GitHub blob URL with the branch as an {attribute}, resolved per version from src/variables.ts:
//   <ApiReference source="https://github.com/hazelcast/management-center/blob/{mc-repo-swagger-branch}/…/rest-client-api.yaml" />
// Requests are conditional (If-None-Match). A failed fetch fails the build: a page whose spec 404s must not publish.
const STAGING_DIR = '.api-specs'
const CACHE_FILE = 'cache.json'

// Only `source` is read; it is a plain quoted string (the {ref} token is literal text in the attribute).
const API_REFERENCE_RE = /<ApiReference\b[^>]*?\bsource=["']([^"']+)["']/g

const BLOB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/

// GITHUB_TOKEN, GH_TOKEN or GIT_CREDENTIALS. Locally: GITHUB_TOKEN=$(gh auth token).
function githubToken () {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GIT_CREDENTIALS) {
    try {
      return new URL(process.env.GIT_CREDENTIALS).username || null
    } catch {
      return null
    }
  }
  return null
}

// Every (version, spec) pair a docs instance asks for. `versionName` keys src/variables.ts ('current', else the
// release); `seg` is the served URL segment and can differ from it (e.g. `current` vs a snapshot segment), '' if unversioned.
async function collectRequests (siteDir, docsInstances) {
  const requests = []
  for (const { id, currentSeg = '' } of docsInstances) {
    const versions = [{ versionName: 'current', seg: currentSeg, dir: path.join(siteDir, id) }]
    const versionedRoot = path.join(siteDir, `${id}_versioned_docs`)
    if (fs.existsSync(versionedRoot)) {
      for (const entry of fs.readdirSync(versionedRoot)) {
        if (!entry.startsWith('version-')) continue
        const versionName = entry.slice('version-'.length)
        versions.push({ versionName, seg: versionName, dir: path.join(versionedRoot, entry) })
      }
    }
    for (const { versionName, seg, dir } of versions) {
      if (!fs.existsSync(dir)) continue
      const files = await Globby('**/*.{md,mdx}', { cwd: dir, absolute: true })
      for (const file of files) {
        const text = fs.readFileSync(file, 'utf8')
        API_REFERENCE_RE.lastIndex = 0
        let m
        while ((m = API_REFERENCE_RE.exec(text)) !== null) {
          requests.push({ component: id, versionName, seg, source: m[1], file })
        }
      }
    }
  }
  return requests
}

// Resolves a request's {attribute}s for its version, then splits the blob URL into API coordinates.
function resolveRequest (request, variables, versionedVariables) {
  const perVersion = versionedVariables[request.component]?.[request.versionName] || {}
  const resolved = substitute(request.source, { ...variables, ...perVersion })
  const m = BLOB_URL_RE.exec(resolved)
  if (!m) {
    throw new Error(
      `[openapi-specs] ${path.basename(request.file)}: <ApiReference source> must be a GitHub blob URL, got "${resolved}"` +
        (resolved === request.source ? '' : `\n  (declared as "${request.source}")`),
    )
  }
  const [, owner, repo, ref, filePath] = m
  // The spec URL is derived from the source twice: here from the RESOLVED source (staging path), and in
  // src/components/ApiReference from the UNRESOLVED one (request + Download link). specUrlFor reads only the
  // file name, so an {attribute} in the file name would make them disagree and 404 silently; guard it here.
  if (specFileName(request.source) !== specFileName(resolved)) {
    throw new Error(
      `[openapi-specs] ${path.basename(request.file)}: an {attribute} reference must not appear in the FILE NAME of ` +
        `<ApiReference source> — the page derives the spec URL from the unresolved source, so it would request ` +
        `"${specFileName(request.source)}" while the build published "${specFileName(resolved)}".\n` +
        `  declared: ${request.source}\n  resolved: ${resolved}`,
    )
  }
  // Same layout the component derives at render time.
  const versionBase = request.seg ? `/${request.component}/${request.seg}` : `/${request.component}`
  return { ...request, owner, repo, ref, filePath, url: specUrlFor(versionBase, resolved) }
}

async function fetchSpec ({ owner, repo, ref, filePath }, token, etag) {
  const apiUrl =
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(filePath)}` +
    `?ref=${encodeURIComponent(ref)}`
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hazelcast-docs',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (etag) headers['If-None-Match'] = etag

  const response = await fetch(apiUrl, { headers })
  // Conditional hit: the staged file is current and it didn't count against the rate limit.
  if (response.status === 304) return { unchanged: true }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // A private repo answers unauthenticated requests with 404, so name the missing token.
    const hint = response.status === 404 && !token
      ? ' — no GITHUB_TOKEN in the environment, and this spec repo is private'
      : ''
    throw new Error(`GitHub API ${response.status} for ${owner}/${repo}@${ref}/${filePath}${hint}\n  ${detail.slice(0, 200)}`)
  }
  const json = await response.json()
  if (typeof json.content !== 'string') {
    throw new Error(`GitHub API returned no content for ${owner}/${repo}@${ref}/${filePath}`)
  }
  return {
    content: Buffer.from(json.content, 'base64').toString('utf8'),
    sha: json.sha,
    etag: response.headers.get('etag'),
  }
}

// Delete anything under the staging dir this run did not write, so dropped specs aren't served stale.
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

module.exports = function openapiSpecsPlugin (context, options) {
  const { variables = {}, versionedVariables = {}, docs = [] } = options || {}
  const siteDir = context.siteDir
  const stagingDir = path.join(siteDir, STAGING_DIR)
  const cachePath = path.join(stagingDir, CACHE_FILE)
  const verbose = !!process.env.HZ_OPENAPI_VERBOSE
  // A build publishes what it stages, so a missing spec is fatal there; dev carries on with what's staged.
  const isBuild = process.env.NODE_ENV === 'production'
  // The spec repos are private, so a build without a token (anyone outside Hazelcast) skips the API pages.
  // Netlify publishes the site, so there a missing token is still fatal.
  const isDeploy = process.env.NETLIFY === 'true'

  return {
    name: 'openapi-specs',

    // Pages that start referencing a spec must be noticed without a restart.
    getPathsToWatch () {
      return docs.flatMap(({ id }) => [
        path.join(siteDir, id, '**/*.{md,mdx}'),
        path.join(siteDir, `${id}_versioned_docs`, '**/*.{md,mdx}'),
      ])
    },

    async loadContent () {
      const requests = (await collectRequests(siteDir, docs)).map((request) =>
        resolveRequest(request, variables, versionedVariables),
      )
      if (requests.length === 0) return

      fs.mkdirSync(stagingDir, { recursive: true })
      const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {}
      const token = githubToken()

      // One request per distinct upstream file; shared specs fetch once and stage several times.
      const byUpstream = new Map()
      for (const request of requests) {
        const key = `${request.owner}/${request.repo}@${request.ref}:${request.filePath}`
        if (!byUpstream.has(key)) byUpstream.set(key, { key, request, targets: [], pages: [] })
        byUpstream.get(key).targets.push(path.join(stagingDir, request.url.replace(/^\//, '')))
        byUpstream.get(key).pages.push(path.relative(siteDir, request.file))
      }

      const staged = new Set()
      const failures = []
      const missingWithoutToken = []
      let updated = 0
      let unchanged = 0
      let unchecked = 0

      await Promise.all(
        [...byUpstream.values()].map(async ({ key, request, targets, pages }) => {
          const cached = cache[key]
          const present = targets.every((t) => fs.existsSync(t))
          // No token, no request: the repos are private, so it would only burn the anonymous rate limit.
          if (!token) {
            if (present) {
              targets.forEach((t) => staged.add(t))
              unchecked++
            } else {
              missingWithoutToken.push(...pages)
            }
            return
          }
          // Dev re-runs this on every docs edit so it fetches only what is missing; a build always revalidates.
          if (present && !isBuild) {
            targets.forEach((t) => staged.add(t))
            unchanged++
            return
          }
          let result
          try {
            result = await fetchSpec(request, token, present ? cached?.etag : null)
          } catch (error) {
            failures.push(`${key}: ${error.message}`)
            return
          }

          if (result.unchanged) {
            unchanged++
          } else {
            updated++
            cache[key] = { etag: result.etag, sha: result.sha }
          }
          // `unchanged` is only returned when every target is already on disk, so there is nothing to write.
          for (const target of targets) {
            if (!result.unchanged) {
              fs.mkdirSync(path.dirname(target), { recursive: true })
              fs.writeFileSync(target, result.content, 'utf8')
            }
            staged.add(target)
          }
          if (verbose) {
            console.log(
              `[openapi-specs] ${result.unchanged ? 'unchanged' : `updated ${result.sha.slice(0, 8)}`}  ${key}`,
            )
          }
        }),
      )

      staged.add(cachePath)
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n')

      // Parse each spec once here (refs resolved, OpenAPI 2.0 upconverted) and hand the result to the page:
      //   anchorsByUrl  every anchor the page publishes, so onBrokenAnchors can validate links into API pages
      //                 (ApiReference registers them via collectAnchor during SSR).
      //   specs / specHashByUrl  the bundled spec, so the browser doesn't fetch and parse YAML.
      // Parsed from the staged file so what's registered is what's published. Required lazily: it's a large
      // module and sites without API pages return above.
      const { loadAndBundleSpec, AppStore } = require('redoc')
      const anchorsByUrl = {}
      const parsedByFile = new Map()
      // Content-addressed: the same spec is published at one URL per version and most are unchanged.
      const specs = {}       // hash -> the bundled document, stored once
      const specHashByUrl = {} // published URL -> that hash
      for (const request of requests) {
        const target = path.join(stagingDir, request.url.replace(/^\//, ''))
        if (!staged.has(target) || !fs.existsSync(target)) continue
        if (!parsedByFile.has(target)) {
          try {
            const spec = await loadAndBundleSpec(target)
            const serialized = JSON.stringify(spec)
            const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16)
            // Anchors come off Redoc's menu so what's registered is what renders; the page builds the same store (plugins/lib/api-anchors).
            const store = new AppStore(spec, target, { disableSearch: true }, false)
            parsedByFile.set(target, {
              spec,
              hash,
              anchors: menuAnchors(store),
              collisions: anchorCollisions(store),
            })
          } catch (error) {
            // Not fatal here: an unreadable spec is already a broken page, reported by the fetch path.
            parsedByFile.set(target, { spec: null, hash: null, anchors: [], collisions: [] })
            console.warn(`[openapi-specs] could not parse ${request.url}: ${error.message}`)
          }
        }
        const parsed = parsedByFile.get(target)
        anchorsByUrl[request.url] = parsed.anchors
        if (parsed.spec) {
          specs[parsed.hash] = parsed.spec
          specHashByUrl[request.url] = parsed.hash
        }
      }
      // Non-distinct operation anchors would send links to the wrong operation silently. Reported after the loop so one run names every clash; fatal on build.
      const collisions = [...parsedByFile.entries()].flatMap(([target, parsed]) =>
        (parsed.collisions || []).map(
          ({ anchor, items }) => `${path.basename(target)}: "#${anchor}" is published by ${items.join(' and ')}`,
        ),
      )
      if (collisions.length) {
        const message = `[openapi-specs] ${collisions.length} colliding operation anchor(s):\n  ${collisions.join('\n  ')}`
        if (isBuild) throw new Error(message)
        console.warn(message)
      }

      // Prune only after a complete run: after a failure, unwritten targets look like withdrawn ones.
      if (!failures.length && !missingWithoutToken.length) pruneStale(stagingDir, staged)

      // Without a token a build can't check the staged specs against the product repos; say so.
      if (!token && isBuild && unchecked) {
        console.warn(
          '[openapi-specs] no GitHub token set. The staged specs were published without being' +
          ' checked against the repos that own them.',
        )
      }
      if (missingWithoutToken.length) {
        // One message per run: single cause, single fix. Names the pages, not the private repos.
        const pages = [...new Set(missingWithoutToken)].sort()
        const message =
          `[openapi-specs] no GitHub token set. ${pages.length} API reference page(s) need a spec ` +
          `from a private repo and are not included in this build:\n  ${pages.join('\n  ')}`
        if (isDeploy) throw new Error(message)
        console.warn(`${message}\n  Links into those pages report as broken anchors.`)
      }
      if (failures.length) {
        const message =
          `[openapi-specs] could not fetch ${failures.length} spec(s):\n  ${failures.join('\n  ')}`
        if (isBuild) throw new Error(message)
        console.warn(message)
      }
      const anchorCount = Object.values(anchorsByUrl).reduce((n, a) => n + a.length, 0)
      console.log(
        `[openapi-specs] ${requests.length} spec reference(s) staged from ${byUpstream.size} upstream file(s)` +
          ` (${updated} updated, ${unchanged} unchanged${unchecked ? `, ${unchecked} not checked` : ''});` +
          ` ${anchorCount} anchor(s) registered; ${Object.keys(specs).length} distinct spec(s) embedded`,
      )
      if (!token && !isBuild && unchecked) {
        console.warn(
          '[openapi-specs] no GitHub token set. The staged specs were not checked against the' +
          ' repos that own them and may be out of date.',
        )
      }
      return { anchorsByUrl, specs, specHashByUrl }
    },

    // Anchors go via global data (small; ApiReference needs them during SSR). The specs are too big for every
    // page, so they go in a generated file imported only by Renderer.tsx (lazy, inside BrowserOnly).
    // Written unconditionally: Renderer's import is static, so the file must exist for the site to compile.
    async contentLoaded ({ content, actions }) {
      const { anchorsByUrl = {}, specs = {}, specHashByUrl = {} } = content || {}
      await actions.createData('specs.json', JSON.stringify({ specs, specHashByUrl }))
      actions.setGlobalData({ anchorsByUrl })
    },
  }
}
