'use strict'

// Link/anchor extraction from a rendered HTML page (golden fragment or a
// converted page). Pure over the HTML string; the resolving/checking against
// the manifest lives in the runner so this stays reusable for both sides.

const cheerio = require('cheerio')

// Classify and resolve every <a href> on a page whose own URL is pageUrl.
//   - "#foo"                  -> { kind: 'anchor', anchor: 'foo' }        (same page)
//   - "https://otherhost/x"   -> { kind: 'external' }                     (skip)
//   - "https://<siteHost>/x"  -> { kind: 'internal', path, anchor }       (this site)
//   - "../rel/path#frag"      -> { kind: 'internal', path, anchor }       (resolved vs pageUrl)
//   - "mailto:", "tel:", ...  -> { kind: 'external' }
// pageUrl must be the page's real site path (e.g. "/cloud/install" or
// "/hazelcast/5.7/") so relative links resolve exactly as a browser would.
function classifyHref (href, pageUrl, siteHost) {
  const raw = (href || '').trim()
  if (!raw || raw.startsWith('#') === false && /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // Has a scheme (http:, mailto:, tel:, javascript:, data:, ...).
    if (/^https?:/i.test(raw)) {
      let u
      try { u = new URL(raw) } catch { return { kind: 'malformed', href: raw } }
      if (u.host === siteHost) {
        return { kind: 'internal', path: u.pathname, anchor: decodeURIComponent(u.hash.replace(/^#/, '')) || null }
      }
      return { kind: 'external', href: raw }
    }
    return { kind: 'external', href: raw }
  }
  if (raw.startsWith('#')) {
    return { kind: 'anchor', anchor: decodeURIComponent(raw.slice(1)) || null }
  }
  // Relative or root-relative; resolve against the page URL.
  let u
  try {
    u = new URL(raw, `https://${siteHost}${pageUrl}`)
  } catch {
    return { kind: 'malformed', href: raw }
  }
  return { kind: 'internal', path: u.pathname, anchor: decodeURIComponent(u.hash.replace(/^#/, '')) || null }
}

// Extract the id anchors a page defines (heading ids etc.), and the classified
// outgoing links. `fragment: true` for golden files (no <html> wrapper).
function extractLinks (html, pageUrl, siteHost, { fragment = true } = {}) {
  const $ = cheerio.load(html, null, !fragment)
  const ids = new Set()
  $('[id]').each((_, el) => ids.add($(el).attr('id')))
  // Antora also emits <a name="..."> in a few spots; treat those as anchors too.
  $('a[name]').each((_, el) => ids.add($(el).attr('name')))
  const links = []
  $('a[href]').each((_, el) => {
    links.push(classifyHref($(el).attr('href'), pageUrl, siteHost))
  })
  return { ids, links }
}

module.exports = { classifyHref, extractLinks }
