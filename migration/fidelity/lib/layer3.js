'use strict'

// Layer 3: link/anchor integrity. For one page, resolve every outgoing link:
//   - same-page "#frag": the id must exist on this page
//   - internal path: the path must be a known site URL (manifest), and if it
//     carries a "#frag", that anchor must exist on the target page (golden
//     anchor index). A target that is a known URL but has no anchor entry
//     (e.g. an image, an alias, or a resolution-only page we did not snapshot)
//     is treated as URL-valid with anchors unverifiable, not a failure.
//     With `convertedAnchors` (url -> Set of ids on OUR built page, or null when
//     the target is not converted), an anchor the golden target has but our
//     target lacks is `dropped-anchor-cross`: the golden index answers "was this
//     ever a real target", the converted one "is it still one". Without the
//     second, a converted page that loses an id passes every inbound deep link.
//     With `isBuilt` (see builtTargetLookup), a target the manifest knows but our
//     build does not serve is `dead-link-built`.
//   - external / mailto / tel: not checked here.
// Returns a list of problems, each tagged so the report can rank them.

const { extractLinks } = require('./links')

function checkPage ({ html, pageUrl, ids: ownIds, fragment = true }, { manifestIndex, anchorIndex, siteHost, convertedAnchors, isBuilt }) {
  const { ids, links } = extractLinks(html, pageUrl, siteHost, { fragment })
  const selfIds = ownIds || ids
  const problems = []
  for (const link of links) {
    if (link.kind === 'anchor') {
      if (link.anchor && !selfIds.has(link.anchor)) {
        problems.push({ type: 'dead-anchor-self', anchor: link.anchor })
      }
      continue
    }
    if (link.kind === 'malformed') {
      problems.push({ type: 'malformed-href', href: link.href })
      continue
    }
    if (link.kind !== 'internal') continue // external: skip
    const p = link.path
    const canonical = manifestIndex.resolve(p)
    if (!canonical) {
      problems.push({ type: 'dead-link', path: p, anchor: link.anchor || null })
      continue
    }
    if (isBuilt && !isBuilt(canonical)) {
      problems.push({ type: 'dead-link-built', path: canonical, anchor: link.anchor || null })
      continue
    }
    if (link.anchor) {
      const targetAnchors = anchorIndex.get(canonical) ||
        anchorIndex.get(canonical.replace(/\/$/, '')) || anchorIndex.get(canonical + '/')
      if (targetAnchors && !targetAnchors.has(link.anchor)) {
        problems.push({ type: 'dead-anchor-cross', path: canonical, anchor: link.anchor })
      } else if (targetAnchors && convertedAnchors) {
        const ours = convertedAnchors(canonical)
        if (ours && !ours.has(link.anchor)) {
          problems.push({ type: 'dropped-anchor-cross', path: canonical, anchor: link.anchor })
        }
      }
    }
  }
  return problems
}

module.exports = { checkPage }
