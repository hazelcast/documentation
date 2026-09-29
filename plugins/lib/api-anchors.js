'use strict'

// Anchor id of an API operation: a slug of method + path (`post /a/{b}` -> `post-a-b`).
// Method + path is the operation's identity (a summary is prose that gets reworded); changing either is a breaking API change.
// Shared by the build plugin (plugins/openapi-specs) and the renderer (src/components/ApiReference), both
// reading Redoc's menu model, so registered and rendered ids cannot drift.

// Path-item keys that are operations (a path item also holds summary, parameters, servers, $ref).
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function operationAnchor (method, specPath) {
  return slug(`${method}-${specPath}`)
}

// Operations get the method+path slug; other items (tag groups, description headings) keep Redoc's own id.
function menuItemAnchor (item) {
  return item.type === 'operation' && item.httpVerb && item.path
    ? operationAnchor(item.httpVerb, item.path)
    : item.id
}

// Every anchor a page publishes, read off Redoc's menu (what actually renders). Both the slug and Redoc's own
// id are registered: the latter is still on the markup and inbound links use it, so onBrokenAnchors validates either.
function menuAnchors (store) {
  const anchors = new Set()
  for (const item of menuItemsOf(store)) {
    anchors.add(menuItemAnchor(item))
    if (item.id) anchors.add(item.id)
  }
  return [...anchors]
}

const menuItemsOf = (store) => (store && store.menu && store.menu.flatItems) || []

// Menu items sharing one anchor (slugs drop punctuation, so paths can collide). menuAnchors dedupes,
// so this needs its own check; the plugin runs it against the real specs on every build.
function anchorCollisions (store) {
  const byAnchor = new Map()
  for (const item of menuItemsOf(store)) {
    const anchor = menuItemAnchor(item)
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, [])
    // Name the spec identity, not the anchor, so a report shows what a contributor must tell apart.
    byAnchor.get(anchor).push(item.type === 'operation' ? `${item.httpVerb} ${item.path}` : item.id)
  }
  return [...byAnchor]
    .filter(([, items]) => items.length > 1)
    .map(([anchor, items]) => ({ anchor, items }))
}

module.exports = { HTTP_METHODS, operationAnchor, menuItemAnchor, menuAnchors, anchorCollisions }
