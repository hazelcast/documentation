'use strict'

// Layer 3 resolver, built from manifest.json. Answers: does this site-absolute
// path correspond to something the site actually serves, and if so under what
// canonical URL? A path is valid if it is a page/image/attachment URL, or an
// alias URL (aliases 307 to a real page). The manifest is the source of truth
// for URLs, so this needs no rendered output.
//
// Two forms production serves that are NOT literal manifest URLs, both verified
// against the live site:
//   - version aliases: /<comp>/latest/<rest>     -> /<comp>/<latestVersion>/<rest>
//                       /<comp>/latest-dev/<rest> -> /<comp>/<prereleaseVersion>/<rest>
//     (307 redirects; e.g. /hazelcast/latest/... serves the 5.7 page)
//   - .html suffix: /<path>.html                 -> /<path>
//     (html_extension_style: drop leaves the extensionless URL canonical, but
//     the server still serves the .html form)
// resolve() returns the CANONICAL manifest URL so callers (anchor checks) look
// up the real target, not the alias.

function variants (url) {
  const set = new Set([url])
  if (url.length > 1) {
    if (url.endsWith('/')) set.add(url.slice(0, -1))
    else set.add(url + '/')
  }
  return set
}

function buildIndex (manifest) {
  const byFamily = { page: new Set(), image: new Set(), attachment: new Set(), alias: new Set() }
  const all = new Set()
  for (const r of manifest.resources || []) {
    if (!r.url) continue
    const bucket = byFamily[r.family]
    for (const v of variants(r.url)) {
      if (bucket) bucket.add(v)
      all.add(v)
    }
  }

  // component -> { latest: <version>, 'latest-dev': <version> } for alias rewrites.
  const aliasTargets = new Map()
  for (const c of manifest.components || []) {
    const entry = {}
    if (c.latestVersion) entry.latest = c.latestVersion
    const pre = (c.versions || []).find((v) => v.prerelease)
    if (pre) entry['latest-dev'] = pre.version
    if (Object.keys(entry).length) aliasTargets.set(c.name, entry)
  }

  // Return the canonical URL a path maps to, or null. Tries: direct, .html
  // strip, then version-alias rewrite (which is itself re-resolved so a rewrite
  // can still hit the trailing-slash/.html variants).
  function resolve (p) {
    if (!p) return null
    if (all.has(p)) return p
    const noHtml = p.replace(/\.html$/, '')
    if (noHtml !== p && all.has(noHtml)) return noHtml
    const m = p.match(/^\/([^/]+)\/(latest|latest-dev)(\/.*)?$/)
    if (m) {
      const targets = aliasTargets.get(m[1])
      const target = targets && targets[m[2]]
      if (target) {
        const rest = m[3] || '/'
        return resolve(`/${m[1]}/${target}${rest}`)
      }
    }
    return null
  }

  return {
    resolve,
    has: (p) => resolve(p) !== null,
    kindOf: (p) => {
      const c = resolve(p)
      if (!c) return null
      for (const fam of ['page', 'image', 'attachment', 'alias']) {
        if (byFamily[fam].has(c)) return fam
      }
      return null
    },
    counts: Object.fromEntries(Object.entries(byFamily).map(([k, s]) => [k, s.size])),
    siteUrl: (manifest.site && manifest.site.url) || 'https://docs.hazelcast.com',
  }
}

module.exports = { buildIndex, variants }
