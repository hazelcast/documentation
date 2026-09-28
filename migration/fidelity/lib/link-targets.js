'use strict'

// WHERE each link goes, in document order. Layer 2's `links` is a count and
// Layer 3 only asks whether a target resolves, so a link that points at a
// different valid page, or an external URL that changed, passes both.
//
// Both sides are reduced to the same form, so that only a change of DESTINATION
// is a difference:
//   - internal: the canonical manifest URL (folding `/latest/`, `.html` and
//     trailing-slash variants), with a redirect followed to where it lands --
//     a page alias, or an orphan page withheld with a `redirect` disposition,
//     both of which the golden links to directly and the converter retargets
//     -- plus the fragment
//   - an attachment: `attachment:<file name>`, since Docusaurus serves it at a
//     content-hashed /assets/files/ URL (the accepted L3 entries record why)
//   - same-page: `#frag`
//   - external: the href, percent-decoded, since Docusaurus re-encodes URLs
//
// Two deliberate converter divergences are recognised here rather than
// accepted page by page, each under the converter's own guards:
//   - own version (sameComponentOwnVersion, converter/lib/html-to-mdx.js): a
//     same-component link Antora sent to the component's latest release, from a
//     page in another version, is judged as the same page in the page's own
//     version, when that page exists.
//   - healed doc refs (healDocRef): a `link:foo.adoc` that 404s in production is
//     judged as `foo` when that is a real page.
// Both are applied to BOTH sides, so each is a no-op on output that already
// took the step, and anything else the converter changes still shows.

const cheerio = require('cheerio')
const { classifyHref } = require('./links')
const { buildIndex } = require('./manifest-index')
const { isCountedLink } = require('./structure')
const { redirectRoute } = require('../../lib/dispositions')

const HASHED_ASSET = /^\/assets\/files\/(.+)-[0-9a-f]{32}(\.[^./]+)$/i

// url -> where a request for it ends up: aliases from the manifest, plus pages
// the orphan triage turned into redirects.
function redirectMap (manifest, dispositions) {
  const map = new Map()
  for (const r of manifest.resources || []) {
    if (r.family === 'alias' && r.aliasTo) map.set(r.url, r.aliasTo)
    else if (r.family === 'page' && dispositions) {
      const to = redirectRoute(dispositions, r)
      if (to) map.set(r.url, to)
    }
  }
  return map
}

// Everything targetOf needs, from the manifest (and the orphan dispositions).
function linkDeps (manifest, dispositions) {
  const manifestIndex = buildIndex(manifest)
  const latest = {}
  for (const c of manifest.components || []) if (c.latestVersion) latest[c.name] = c.latestVersion
  return { manifestIndex, siteHost: new URL(manifestIndex.siteUrl).host, redirects: redirectMap(manifest, dispositions), latest }
}

function follow (url, redirects, manifestIndex) {
  for (let hops = 0; hops < 5 && redirects.has(url); hops++) url = manifestIndex.resolve(redirects.get(url)) || redirects.get(url)
  return url
}

function ownVersion (url, pageUrl, latest, manifestIndex) {
  const t = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url)
  const p = /^\/([^/]+)\/([^/]+)/.exec(pageUrl)
  if (!t || !p || t[1] !== p[1] || t[2] === p[2] || latest[t[1]] !== t[2]) return url
  return manifestIndex.resolve(`/${t[1]}/${p[2]}${t[3] || '/'}`) || url
}

const decode = (s) => { try { return decodeURI(s) } catch { return s } }

function targetOf (href, pageUrl, { manifestIndex, siteHost, redirects = new Map(), latest = {} }) {
  const link = classifyHref(href, pageUrl, siteHost)
  const frag = link.anchor ? '#' + link.anchor : ''
  if (link.kind === 'anchor') return frag || '#'
  if (link.kind === 'internal') {
    const hashed = HASHED_ASSET.exec(link.path)
    if (hashed) return `attachment:${hashed[1]}${hashed[2]}`
    const canonical = manifestIndex.resolve(link.path) ||
      (/\.adoc$/.test(link.path) ? manifestIndex.resolve(link.path.replace(/\.adoc$/, '')) : null)
    if (canonical && manifestIndex.kindOf(canonical) === 'attachment') return `attachment:${canonical.split('/').pop()}`
    return ownVersion(follow(canonical || link.path, redirects, manifestIndex), pageUrl, latest, manifestIndex) + frag
  }
  return decode((href || '').trim())
}

function linkTargets (html, pageUrl, deps, { fragment = true } = {}) {
  const $ = cheerio.load(html, null, !fragment)
  const out = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (isCountedLink(href)) out.push(targetOf(href, pageUrl, deps))
  })
  return out
}

module.exports = { linkTargets, targetOf, redirectMap, linkDeps }
