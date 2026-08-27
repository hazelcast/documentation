'use strict'

// The anchor id of one operation on an API reference page.
//
// Neither of the two ids these pages already carry is something a docs
// contributor can reasonably write down. Antora's swagger_ui pages anchored an
// operation by the JSON POINTER of its spec node --
// `#/paths/~1rest~1clusters~1{cluster}~1clientfiltering~1lists/post` -- and that
// is the form that ended up copy-pasted into the AsciiDoc sources. Redoc anchors
// it by an id of its own, `#operation/createFilteringRules`, which reads better
// but only exists where the spec gives an `operationId`: the WAN spec gives none
// for any of its 13 operations, so there Redoc falls back to the pointer again.
//
// So the site publishes its own, an ordinary heading-style slug of the two things
// that identify an operation in the spec -- its METHOD and its PATH:
//
//   post /rest/clusters/{cluster}/clientfiltering/lists
//     -> post-rest-clusters-cluster-clientfiltering-lists
//
// Method + path rather than the operation's summary, because a summary is prose:
// it gets reworded upstream and every anchor into that operation would rot.
// Method + path IS the operation's identity, and changing either is a breaking
// API change -- the one time the anchor SHOULD move.
//
// Shared by the plugin that REGISTERS these anchors at build time
// (plugins/openapi-specs) and the component that RENDERS them
// (src/components/ApiReference), both of which now read the SAME thing -- Redoc's
// menu model of the spec -- so the id Docusaurus validates a link against and the
// id actually on the page cannot drift apart. Checked over all five Management
// Center specs (69 operations) and Platform's (50): no collisions.

// OpenAPI's fixed set of path-item operation keys. A path item also holds
// non-operation keys (`summary`, `parameters`, `servers`, `$ref`), so the
// methods are listed rather than inferred from what is there.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function operationAnchor (method, specPath) {
  return slug(`${method}-${specPath}`)
}

// The anchor one menu item is published under.
//
// An OPERATION gets the readable method+path slug above. Anything else -- a tag
// group, or a heading inside a spec's description -- keeps Redoc's own id, which
// is already readable (`tag/Health-Controller`, `section/...`) and, unlike an
// operation's, has no path and verb to derive a better one from.
function menuItemAnchor (item) {
  return item.type === 'operation' && item.httpVerb && item.path
    ? operationAnchor(item.httpVerb, item.path)
    : item.id
}

// Every anchor an API page publishes, read off Redoc's MENU rather than the raw
// `paths` object, because the menu is what actually renders: an entry here and a
// heading on the page are the same list walked twice.
//
// Two anchors per item, not one. The first is what the page ADVERTISES -- the
// readable slug its heading carries, which is what a hash-link copies. The second
// is Redoc's own id, which the rendered markup ALSO carries (the wrapper div, see
// Operation.tsx) because it is a real anchor these pages used to publish and
// inbound links out there still use it: Platform's spec gives every operation an
// operationId, so Redoc anchors them `tag/Data-Controller/operation/clearMap`,
// and that is the form the AsciiDoc sources link by. Registering both is what
// lets `onBrokenAnchors` police EVERY anchor the page honours -- so a link
// written either way is validated, and a link with a genuine typo in it is still
// told apart from one of these.
function menuAnchors (store) {
  const anchors = new Set()
  for (const item of menuItemsOf(store)) {
    anchors.add(menuItemAnchor(item))
    if (item.id) anchors.add(item.id)
  }
  return [...anchors]
}

const menuItemsOf = (store) => (store && store.menu && store.menu.flatItems) || []

// Two menu items publishing the SAME anchor, which is the one way this scheme can
// go quietly wrong: a slug drops everything that is not a letter or digit, so two
// paths differing only in punctuation collide, and then half the links into one of
// them land on the other with nothing to show for it. menuAnchors deduplicates, so
// a collision cannot be caught by counting the anchors either -- hence a check of
// its own, which the plugin runs over the REAL specs on every build rather than a
// test over a fixture. Clean over all six specs in the corpus (119 operations),
// which is what makes this a guard rather than a known failure.
function anchorCollisions (store) {
  const byAnchor = new Map()
  for (const item of menuItemsOf(store)) {
    const anchor = menuItemAnchor(item)
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, [])
    // The item's identity in the SPEC, not the anchor's: what a report has to name
    // is the two things a contributor then has to tell apart.
    byAnchor.get(anchor).push(item.type === 'operation' ? `${item.httpVerb} ${item.path}` : item.id)
  }
  return [...byAnchor]
    .filter(([, items]) => items.length > 1)
    .map(([anchor, items]) => ({ anchor, items }))
}

module.exports = { HTTP_METHODS, operationAnchor, menuItemAnchor, menuAnchors, anchorCollisions }
