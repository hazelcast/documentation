'use strict'

// Character-reference text that SURVIVES decoding: `&amp;`, `&#39;`, `&lt;`, as
// literal characters in a text node or an attribute a reader or assistive
// technology gets. That is the signature of a value escaped twice -- Docusaurus's
// image transform did it to alt text (src/remark/imageAltUnescape.ts), and a
// screen reader read the entity out. Layer 1 cannot see it in an attribute, and
// nothing compares page chrome (sidebar labels, breadcrumbs, <title>, meta tags)
// at all.
//
// Counted by context and entity, so a page that legitimately shows entity text
// (a code sample about XML escaping) compares equal to its golden. URL-valued
// attributes are skipped: `&amp;` in a query string is a URL's business.

const cheerio = require('cheerio')

const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});/g
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'data-src'])

function entityText (html, { fragment = true } = {}) {
  const $ = cheerio.load(html, null, !fragment)
  $('script, style').remove()
  const counts = new Map()
  const add = (key) => counts.set(key, (counts.get(key) || 0) + 1)
  $('*').each((_, el) => {
    for (const [name, value] of Object.entries(el.attribs || {})) {
      if (URL_ATTRS.has(name)) continue
      for (const m of value.match(ENTITY) || []) add(`@${name} ${m}`)
    }
  })
  $('*').contents().each((_, node) => {
    if (node.type !== 'text') return
    const where = $(node.parent).closest('pre, code').length ? 'code' : 'text'
    for (const m of node.data.match(ENTITY) || []) add(`${where} ${m}`)
  })
  return counts
}

// golden/converted: Maps from entityText. One diff listing every key whose count
// differs, or none.
function compareEntityText (golden, converted) {
  const keys = [...new Set([...golden.keys(), ...converted.keys()])].sort()
  const at = keys.filter((k) => (golden.get(k) || 0) !== (converted.get(k) || 0))
  if (!at.length) return []
  return [{
    field: 'entityText',
    golden: at.map((k) => `${k} x${golden.get(k) || 0}`).join(', '),
    converted: at.map((k) => `${k} x${converted.get(k) || 0}`).join(', '),
  }]
}

module.exports = { entityText, compareEntityText }
