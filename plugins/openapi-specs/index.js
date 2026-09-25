'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Globby } = require('@docusaurus/utils')

const substitute = require('../lib/substitute-attributes')
const { specFileName, specUrlFor } = require('../lib/api-spec-url')
const { menuAnchors, anchorCollisions } = require('../lib/api-anchors')

// Stages the OpenAPI specs the API-reference pages render. Permanent replacement
// for the Antora swagger_ui block macro (hazelcast-docs-tools), and the reason
// the site can render an API page at all: the specs live in PRIVATE product
// repos, so a browser cannot fetch them from GitHub -- the docs site has to serve
// them itself, exactly as the Antora build does today.
//
// The specs are NEVER copied into this repo. Their source of truth is the
// product repo, and this plugin fetches them from there on every build into a
// gitignored staging dir that is registered as a second `staticDirectories`
// entry (see docusaurus.config.ts), which Docusaurus copies on `build` and
// serves on `start`. Nothing here can drift from the product repo, and there is
// no committed copy to keep in step.
//
// What a page declares is the same GitHub blob URL the AsciiDoc macro took, with
// the branch left as an {attribute} reference:
//
//   <ApiReference source="https://github.com/hazelcast/management-center/blob/{mc-repo-swagger-branch}/…/rest-client-api.yaml" />
//
// so the ref is resolved PER VERSION from src/variables.ts (5.11 docs read the
// 5.11.0 branch) and the attribute stays single-sourced rather than baked.
//
// Differences from the macro it replaces, all deliberate:
//   - only the LIVE version set is fetched (4 MC versions x 5 specs), not every
//     version the build has ever published;
//   - responses are conditional (If-None-Match), so a rebuild transfers nothing
//     and 304s do not count against the API rate limit;
//   - one summary line per run instead of four log lines per spec per version
//     (set HZ_OPENAPI_VERBOSE=1 for the detail);
//   - a failed fetch FAILS THE BUILD. The macro logs the error and falls back to
//     the raw GitHub blob URL, which publishes a page whose Redoc points at a
//     private repo and 404s for every reader.

const STAGING_DIR = '.api-specs'
const CACHE_FILE = 'cache.json'

// Matches the component the MDX pages use. Deliberately narrow: `source` is the
// only attribute read here, and it is always a plain quoted string (the {ref}
// token inside it is literal text in a JSX attribute, not an expression).
const API_REFERENCE_RE = /<ApiReference\b[^>]*?\bsource=["']([^"']+)["']/g

const BLOB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/

// The same GITHUB_TOKEN / GIT_CREDENTIALS pair the Antora macro accepts, so an
// existing CI environment needs no new secret. Locally: GITHUB_TOKEN=$(gh auth token).
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

// Every (version, spec) pair a docs instance asks for. `versionName` is the key
// src/variables.ts stores per-version values under ('current', else the release);
// `seg` is the URL segment that version is served at, which is NOT the same
// string (management-center's current version is `current` in variables and
// `5.12-snapshot` in URLs), and is '' for an unversioned component.
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

// Resolve one request's {attribute} references against the values that version
// publishes, then split the GitHub blob URL into its API coordinates.
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
  // The published URL is derived from the source TWICE, by two different halves
  // of this system, and they must land on the same string:
  //   here, from the RESOLVED source, to decide where to stage the file;
  //   in src/components/ApiReference, from the UNRESOLVED source (the page never
  //   resolves attributes), to decide what to request and what the Download
  //   button points at.
  // specUrlFor reads only the FILE NAME, so the two agree for as long as no
  // attribute reference sits in that part of the URL. Put one there --
  // `.../rest-client-api-{some-version}.yaml` -- and this would stage
  // `rest-client-api-5.11.0.yaml` while the page asked for
  // `rest-client-api-{some-version}.yaml`: the reference fails to load and the
  // Download button 404s, on every version, silently.
  //
  // Checked here because this is the one place both forms of the source are in
  // hand. It is a build-time guard rather than a test on purpose: the invariant
  // is permanent (unlike migration/, which is deleted when the migration ends),
  // and a guard on the real data cannot go unrun.
  if (specFileName(request.source) !== specFileName(resolved)) {
    throw new Error(
      `[openapi-specs] ${path.basename(request.file)}: an {attribute} reference must not appear in the FILE NAME of ` +
        `<ApiReference source> — the page derives the spec URL from the unresolved source, so it would request ` +
        `"${specFileName(request.source)}" while the build published "${specFileName(resolved)}".\n` +
        `  declared: ${request.source}\n  resolved: ${resolved}`,
    )
  }
  // Same layout the component derives at render time, so the file is staged at
  // exactly the URL the page will request.
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
  // A conditional hit: the staged file is already current, and this response did
  // not count against the rate limit.
  if (response.status === 304) return { unchanged: true }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // A private repo answers an unauthenticated request with 404, not 403, so
    // the missing token has to be named or this reads as a bad path.
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

// Delete anything under the staging dir that this run did not write. A spec that
// a page stops referencing (or that is renamed upstream) would otherwise linger
// and keep being published from a stale copy.
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
  // A build publishes what it stages, so a spec it could not fetch is a broken
  // page; the dev server is allowed to carry on with whatever is already staged.
  const isBuild = process.env.NODE_ENV === 'production'

  return {
    name: 'openapi-specs',

    // A page that starts referencing a spec has to be noticed without a restart.
    // Re-running is cheap: in dev it is a glob and a stat per spec, and only a
    // spec with nothing staged for it costs a request.
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

      // One request per DISTINCT upstream file. Two versions pinned to the same
      // branch (or two pages sharing a spec) fetch once and stage twice.
      const byUpstream = new Map()
      for (const request of requests) {
        const key = `${request.owner}/${request.repo}@${request.ref}:${request.filePath}`
        if (!byUpstream.has(key)) byUpstream.set(key, { key, request, targets: [] })
        byUpstream.get(key).targets.push(path.join(stagingDir, request.url.replace(/^\//, '')))
      }

      const staged = new Set()
      const failures = []
      const missingWithoutToken = []
      let updated = 0
      let unchanged = 0
      let unchecked = 0

      await Promise.all(
        [...byUpstream.values()].map(async ({ key, request, targets }) => {
          const cached = cache[key]
          const present = targets.every((t) => fs.existsSync(t))
          // No token, no request. These repos are private, so an unauthenticated
          // fetch cannot succeed — it can only spend the anonymous rate limit and
          // turn one missing token into a page of 403s.
          if (!token) {
            if (present) {
              targets.forEach((t) => staged.add(t))
              unchecked++
            } else {
              missingWithoutToken.push(key)
            }
            return
          }
          // The dev server re-runs this on every docs edit (getPathsToWatch), so
          // it fetches only what is MISSING; a build always revalidates, because
          // a build is what publishes, and the branch these specs track moves.
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
          // `unchanged` is only ever returned when every target was already on
          // disk -- the conditional header is sent only in that case -- so there
          // is nothing to write back.
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

      // Each spec is PARSED HERE, once, at build time -- $refs resolved, OpenAPI
      // 2.0 upconverted -- and the result is handed to the page in two forms:
      //
      //   anchorsByUrl  every anchor the page publishes, so Docusaurus can
      //                 VALIDATE a link into an API page the way it validates a
      //                 link to a heading (onBrokenAnchors). Nothing else in the
      //                 build can see them: the operations render in the browser,
      //                 and an anchor only exists to Docusaurus if something calls
      //                 collectAnchor during the SSR pass -- which
      //                 src/components/ApiReference does with this data.
      //   specsByUrl    the BUNDLED spec itself, so the page does not fetch and
      //                 parse YAML in the browser. That parse (@redocly/openapi-
      //                 core, in the browser, on every visit) was the bulk of the
      //                 delay between the page appearing and the reference
      //                 appearing in it. The bundled JSON is SMALLER than the YAML
      //                 it replaces (52KB for all five MC specs), and it reaches
      //                 only the API pages -- see the import in Renderer.tsx.
      //
      // Read back off the STAGED file, not the fetch response, so what is
      // registered and embedded is what is actually published. Redoc's own loader
      // does the parse, so the plugin and the page cannot disagree about what a
      // spec contains -- and it needs no YAML dependency of its own. Required
      // lazily: it pulls in a large module, and a site with no API pages returns
      // above without ever reaching this.
      const { loadAndBundleSpec, AppStore } = require('redoc')
      const anchorsByUrl = {}
      const parsedByFile = new Map()
      // Content-addressed, because the SAME spec is published at up to one URL
      // per version and most versions do not change it: across the four live
      // Management Center versions the 20 published specs are only 7 distinct
      // documents. Storing them by URL shipped each one up to four times.
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
            // The anchors come off Redoc's MENU, not the `paths` object, so what
            // is registered is exactly what renders -- tag groups included, which
            // Platform's spec is the first to have. Building the store here is
            // also what makes that list agree with the page's: the page builds the
            // same store from the same document, and both walk it with the same
            // helper (plugins/lib/api-anchors).
            const store = new AppStore(spec, target, { disableSearch: true }, false)
            parsedByFile.set(target, {
              spec,
              hash,
              anchors: menuAnchors(store),
              collisions: anchorCollisions(store),
            })
          } catch (error) {
            // Not fatal HERE: an unreadable spec is already a broken page, and the
            // fetch/publish path above is what reports that. The page falls back
            // to telling the reader where the spec is published.
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
      // A spec whose operations do not all get DISTINCT anchors, which would send
      // some of the links into them to the wrong operation with nothing on the
      // page or in the build to show it. Reported after the loop so one run names
      // every clash rather than stopping at the first, and fatal on a build for the
      // same reason an unfetchable spec is: what it breaks is published.
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

      // Only a run that fetched everything it meant to knows what is stale. After
      // a failure the unwritten targets are indistinguishable from withdrawn
      // ones, and pruning would throw away copies that are still serving.
      if (!failures.length && !missingWithoutToken.length) pruneStale(stagingDir, staged)

      // A build publishes what it stages. Without a token it cannot check any of
      // it against the product repo, so it says so rather than quietly shipping
      // whatever a previous run happened to leave behind.
      if (!token && isBuild && staged.size) {
        console.warn(
          '[openapi-specs] no GitHub token set, so the staged specs were published without being' +
          ' checked against the repos that own them. Set GITHUB_TOKEN in CI.',
        )
      }
      if (missingWithoutToken.length) {
        // One message for the whole run, not one per spec: there is a single
        // cause and a single fix.
        const message =
          `[openapi-specs] ${missingWithoutToken.length} spec(s) are not staged and no GitHub token ` +
          'is set, so they cannot be fetched — the repos that own them are private.' +
          `\n  ${missingWithoutToken.join('\n  ')}`
        if (isBuild) throw new Error(message)
        console.warn(`${message}\n  Those API pages will not render. Stage them with:` +
          '\n    GITHUB_TOKEN=$(gh auth token) npm start')
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
          '[openapi-specs] no GitHub token set, so the staged specs were not checked against the' +
          ' repos that own them and may be out of date. To check them:' +
          '\n    GITHUB_TOKEN=$(gh auth token) npm start',
        )
      }
      return { anchorsByUrl, specs, specHashByUrl }
    },

    // The two halves go to the client by DIFFERENT routes, deliberately.
    //
    // Global data is bundled into every page of the site, so only the anchors go
    // there -- they are small, and ApiReference (which renders on the server;
    // only its Redoc half is browser-only) needs them during the SSR pass to
    // register them.
    //
    // The specs are far too big to put on every page, so they are written as a
    // generated FILE that only Renderer.tsx imports. Renderer is itself pulled in
    // lazily inside BrowserOnly, so the specs land in that lazy chunk and reach
    // nothing but the API pages. Written unconditionally, including when there
    // are no API pages at all: Renderer's import of it is static, so the file has
    // to exist for the site to compile.
    async contentLoaded ({ content, actions }) {
      const { anchorsByUrl = {}, specs = {}, specHashByUrl = {} } = content || {}
      await actions.createData('specs.json', JSON.stringify({ specs, specHashByUrl }))
      actions.setGlobalData({ anchorsByUrl })
    },
  }
}
