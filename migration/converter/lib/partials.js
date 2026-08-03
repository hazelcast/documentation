'use strict'

// Partial factoring: the cross-page decision layer for the sentinels that
// mark-partials.js injects into the golden (<!--hz-partial:start ID--> ... end).
//
// The converter runs per page, but "is this fragment shared, and identical
// everywhere?" is a corpus-wide question. So convert.js does a first pass that
// COLLECTS every sentinel region across all pages, calls decide() once to pick
// which ids become MDX partials, then a second pass that CONVERTS with those
// decisions in hand (html-to-mdx.js replaces a factored region with a component
// reference; a declined region is just inlined as before).
//
// The gate is byte-equality (the user's choice): an id is factored only if every
// one of its occurrences is block-level AND renders identical inner HTML. That
// single rule safely handles all the messy cases surfaced in the cloud sources:
//   - tagged includes (`tag=create`) that slice the same file differently
//     -> distinct inner HTML -> declined ('content-varies');
//   - whole-page `page$` includes whose standalone page body differs from the
//     included copy (title/description/leveloffset) -> declined;
//   - a partial spliced mid-paragraph/-cell -> not block-level -> declined.
// Declined ids keep today's exact output; nothing is ever silently dropped.

const cheerio = require('cheerio')

const START_RE = /^hz-partial:start (.+)$/
// Inline contexts a block-level partial cannot be lifted out of. td/th/li/dd are
// deliberately NOT here: block content (and thus a componentised partial) is
// legitimate inside a cell or list item.
const INLINE_PARENTS = new Set([
  'p', 'span', 'a', 'code', 'em', 'strong', 'b', 'i', 'kbd', 'sup', 'sub', 'mark', 'small', 'del', 'ins', 'u',
])

// id form (resourceId in mark-partials.js): component:module:family$relative
function parseId (id) {
  const a = id.indexOf(':')
  const b = id.indexOf(':', a + 1)
  const component = id.slice(0, a)
  const module = id.slice(a + 1, b)
  const rest = id.slice(b + 1)
  const d = rest.indexOf('$')
  return { component, module, family: rest.slice(0, d), relative: rest.slice(d + 1) }
}

function slugFor (id) {
  const { module, relative } = parseId(id)
  const base = relative.replace(/\.adoc$/, '').replace(/\/+/g, '-')
  return (module && module !== 'ROOT' ? module + '-' : '') + base
}

function componentNameFor (slug) {
  return 'Partial' + slug.split(/[^a-zA-Z0-9]+/).filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1)).join('')
}

function importStmtFor (id, slug, componentName) {
  return `import ${componentName} from '@site/${parseId(id).component}/_partials/${slug}.mdx';`
}

// Every sentinel region in one page's golden HTML -> { id, inner, blockLevel }.
// inner is the re-serialized HTML BETWEEN the sentinels (trimmed); blockLevel is
// false only when the region's immediate parent is an inline element. Regions do
// not nest (the marker wraps outermost runs only), so pairing is a linear scan
// per parent; recursing into inner nodes is harmless (they carry no sentinels).
function collectOccurrences (html) {
  const $ = cheerio.load(html, null, false)
  const out = []
  const walk = (node) => {
    const kids = node.children || []
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (c.type === 'comment') {
        const m = c.data.trim().match(START_RE)
        if (m) {
          const id = m[1].trim()
          const endMark = `hz-partial:end ${id}`
          const inner = []
          let j = i + 1
          while (j < kids.length && !(kids[j].type === 'comment' && kids[j].data.trim() === endMark)) {
            inner.push(kids[j]); j++
          }
          out.push({
            id,
            inner: inner.map((n) => $.html(n)).join('').trim(),
            blockLevel: !INLINE_PARENTS.has(node.name),
          })
        }
      }
    }
    for (const c of kids) if (c.type === 'tag') walk(c)
  }
  walk($.root()[0])
  return out
}

// pagesOcc: [{ url, occ: [{ id, inner, blockLevel }] }] -> { decisions, report }.
// decisions holds ONLY factored ids (id -> { slug, componentName, importStmt,
// representative }); html-to-mdx inlines everything not present. report is the
// full audit (one row per id) for partials-report.json.
function decide (pagesOcc) {
  const byId = new Map()
  for (const p of pagesOcc) {
    for (const o of p.occ) {
      if (!byId.has(o.id)) byId.set(o.id, [])
      byId.get(o.id).push({ url: p.url, inner: o.inner, blockLevel: o.blockLevel })
    }
  }

  const decisions = new Map()
  const report = []
  const slugOwner = new Map()
  for (const [id, occ] of [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { family } = parseId(id)
    const distinct = new Set(occ.map((o) => o.inner))
    const pages = [...new Set(occ.map((o) => o.url))].sort()
    const slug = slugFor(id)

    let decision = 'factored'
    let reason = null
    if (!occ.every((o) => o.blockLevel)) { decision = 'declined'; reason = 'non-block-level' }
    else if (distinct.size > 1) { decision = 'declined'; reason = 'content-varies' }
    else if (slugOwner.has(slug) && slugOwner.get(slug) !== id) { decision = 'declined'; reason = 'slug-collision' }

    let componentName = null
    if (decision === 'factored') {
      slugOwner.set(slug, id)
      componentName = componentNameFor(slug)
      decisions.set(id, {
        slug,
        componentName,
        importStmt: importStmtFor(id, slug, componentName),
        representative: occ[0].inner,
      })
    }
    report.push({
      id, family, occurrences: occ.length, pages, decision, reason,
      slug: decision === 'factored' ? slug : null,
      componentName,
    })
  }
  return { decisions, report }
}

module.exports = { collectOccurrences, decide, slugFor, componentNameFor, parseId }
