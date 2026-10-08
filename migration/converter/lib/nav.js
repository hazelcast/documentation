'use strict'

// Turn an Antora component nav.adoc into a Docusaurus emission plan: where each
// page's .mdx file goes, its slug (to preserve the flat Antora URL), its
// sidebar label/position, and the _category_.json files that reproduce the
// nav's category tree.
//
// nav.adoc grammar we handle:
//   .Category Title            -> a top-level sidebar category (folder)
//   * xref:page.adoc[Label]    -> a page nav item at depth 1
//   ** xref:page.adoc[Label]   -> depth 2 (child of the preceding depth-1 item)
//   * Grouping Label           -> a bullet item with NO xref: a sub-category
//                                 (a non-clickable grouping label whose children
//                                 nest under it) — operator nests this way
//                                 (`* Data`, `** Data structures`).
//   *** / ****                 -> deeper
// A page nav item with children is BOTH a page and a parent. We render it as a
// category folder whose page content becomes `overview.mdx` (sidebar label
// "Overview"), so the category/content split is explicit. URLs are preserved by
// a `slug` on every page.

const path = require('node:path')
const { decodeHTML } = require('entities')
const { foldTypographic } = require('./mdx')

const CATEGORY_RE = /^\.(\S.*)$/
const ITEM_RE = /^(\*+)\s+xref:([^[\]]+?)\[(.*)\]\s*$/
// A bullet item with no xref -> a grouping (sub-category). Captures the depth and
// the label text. Tested only after ITEM_RE fails, so it never eats a page item.
const GROUP_RE = /^(\*+)\s+(\S.*?)\s*$/

// A nav xref target -> { key, stem }.
//
// `key` identifies the PAGE, and must be MODULE-QUALIFIED: it is the plan's map
// key, so a bare stem silently merges same-named pages from different modules.
// That is not hypothetical — management-center has 13 such pages in 5 groups
// (`dashboard` in clusters, cp-subsystem and monitor-streaming; `overview` in
// getting-started, tools and data-structures; …), and merging them meant all but
// the first lost its nav entry AND its output file, because one plan entry
// supplies the relFile both pages are written to.
//
// The qualification is Antora's own coordinate — `module:stem`, bare for ROOT —
// which is also exactly what an injected nav line has to say (see
// injectNavEntries), so one key form serves both.
//
// `stem` is the bare file stem, used for folder names and humanised labels.
//
// Grammar: `[version@][component:][module:]relative/path.adoc[#fragment]`. The
// module is the LAST coordinate segment, so a component-qualified target keys off
// its module too; a target in ANOTHER component is a phantom either way (it
// matches no page in this component's manifest and so plans nothing), which is
// the pre-existing behaviour and not something a component-less planner can fix.
function parseTarget (target) {
  const clean = target.trim().replace(/#.*$/, '')
  const at = clean.indexOf('@')
  const segs = (at === -1 ? clean : clean.slice(at + 1)).split(':')
  const relative = segs.pop().replace(/\.adoc$/, '')
  const stem = relative.split('/').pop()
  const module = segs.length ? segs[segs.length - 1] : ''
  return { key: pageKey(module, relative), stem }
}

// The plan/nav key for a page: Antora's `module:relative` coordinate, with the
// ROOT module left implicit exactly as Antora writes it. Shared by the nav side
// (parseTarget) and the page side (convert.js relFileForPage) so the two cannot
// key the same page differently.
function pageKey (module, relative) {
  return module && module !== 'ROOT' ? `${module}:${relative}` : relative
}

// The bare stem of a plan key (drops the module coordinate) — for folder names
// and humanised labels, which are per-page names, not identifiers.
const keyStem = (key) => key.split(':').pop().split('/').pop()

function parseNav (adoc) {
  const roots = []
  let stack = [] // stack[d] = node whose children receive depth d+1 items
  for (const raw of adoc.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const cat = line.match(CATEGORY_RE)
    if (cat) {
      const node = { type: 'category', label: cat[1].trim(), children: [] }
      roots.push(node)
      stack = [node] // stack[0] is the category; its items are depth 1
      continue
    }
    const item = line.match(ITEM_RE)
    if (item) {
      const depth = item[1].length // 1..4
      const { key, stem } = parseTarget(item[2])
      const node = { type: 'page', key, stem, label: item[3].trim(), children: [] }
      const parent = stack[depth - 1]
      if (!parent) continue // malformed depth jump; skip defensively
      parent.children.push(node)
      stack[depth] = node
      stack.length = depth + 1
      continue
    }
    const group = line.match(GROUP_RE)
    if (group) {
      const depth = group[1].length
      const node = { type: 'category', label: group[2].trim(), children: [] }
      const parent = stack[depth - 1]
      if (!parent) continue // grouping with no parent (depth jump); skip
      // A grouping nests inside its parent's children — but the plan walker only
      // recurses into a category's children when the category is a top-level
      // root or reached via walk(); nested groupings ARE reached via walk()
      // because the parent page/category holds them as children. See buildPlan.
      parent.children.push(node)
      stack[depth] = node
      stack.length = depth + 1
    }
  }
  return roots
}

// A live nav include: `include::[<module>:]partial$<path>[]` on its own line.
// Anchored at line start so a COMMENTED include (`// include::…`, which is how
// every management-center nav disables its module partials) is left alone —
// Asciidoctor does not process it, and neither do we.
const NAV_INCLUDE_RE = /^[ \t]*include::(?:([a-z0-9_-]+):)?partial\$([^[\]]+)\[\s*\]\s*$/
// Any other uncommented include directive in a nav file — a form this resolver
// does not understand. Never silently dropped: see resolveNavIncludes.
const UNKNOWN_INCLUDE_RE = /^[ \t]*include::/

// Resolve a nav.adoc's `include::<module>:partial$nav.adoc[]` lines into the text
// they pull in, SPLICED IN PLACE — which is exactly what Asciidoctor does, and the
// only faithful reading: an included partial's own bullet depths are interpreted
// where the include sat, so position determines the whole subtree's placement.
//
// Platform's nav architecture changed at 5.5: 5.5-and-newer ROOT/nav.adoc is one
// flat file, while 5.4 (22 includes) and 5.3 (27) are skeletons that pull in a
// per-module partial each. Without this, parseNav skips the include lines and
// those versions lose most of their sidebar tree — 235 of 398 pages at 5.4 and
// 333 of 390 at 5.3 land at the component root as `unlisted`. A flat nav has no
// include lines, so this is a no-op on every version that already worked (the
// orphan gate has always expanded includes via the Antora catalog; this is the
// converter catching up to it, and to Antora).
//
// `read(module, relPath)` returns the partial's text, or null/undefined if there
// is no such file; `module` is '' for a partial in the nav's own module.
//
// Fails closed in both directions — an unresolvable partial and an include form
// this does not recognise BOTH throw. A nav include that silently resolves to
// nothing is invisible: it costs a whole subtree of pages their placement while
// the build stays green, which is the failure this function exists to end.
//
// Recursion is bounded and cycle-guarded. Neither is exercised by any live
// version (no Platform nav partial includes another), but a nav include graph is
// data from a frozen source repo, and a self-referential partial should raise a
// legible error rather than blow the stack.
function resolveNavIncludes (adoc, read, seen = [], depth = 0) {
  if (adoc == null) return adoc
  if (depth > MAX_NAV_INCLUDE_DEPTH) {
    throw new Error(`nav includes nested more than ${MAX_NAV_INCLUDE_DEPTH} deep (${seen.join(' -> ')}); cyclic or pathological nav`)
  }
  const out = []
  for (const line of adoc.split('\n')) {
    const m = line.match(NAV_INCLUDE_RE)
    if (!m) {
      if (UNKNOWN_INCLUDE_RE.test(line)) {
        throw new Error(`unsupported include directive in nav.adoc: ${line.trim()}`)
      }
      out.push(line)
      continue
    }
    const [, module = '', relPath] = m
    const coord = `${module || '<self>'}:partial$${relPath}`
    if (seen.includes(coord)) {
      throw new Error(`nav include cycle: ${[...seen, coord].join(' -> ')}`)
    }
    const text = read(module, relPath)
    if (text == null) {
      throw new Error(`nav include "${coord}" could not be resolved to a partial`)
    }
    // Drop the partial's trailing newline: the include occupies ONE line, so
    // keeping it would inject a blank line the source does not have. parseNav
    // skips blanks, so this is tidiness rather than correctness — but it keeps
    // the resolved text a faithful stand-in for what Asciidoctor produces.
    out.push(resolveNavIncludes(text.replace(/\n$/, ''), read, [...seen, coord], depth + 1))
  }
  return out.join('\n')
}

const MAX_NAV_INCLUDE_DEPTH = 10

// Insert nav entries the MIGRATION adds, before the nav is parsed. A page absent
// from nav.adoc gets no plan entry, so the converter drops it at the component
// root as `unlisted: true` — correct for a genuine orphan, wrong for a page that
// was simply forgotten upstream. Injecting here (rather than hand-editing the
// emitted .mdx) means the whole downstream derivation — folder, sidebar_position,
// category, the un-setting of `unlisted` — falls out of buildPlan exactly as it
// does for a page that was in the nav all along, and the fix survives re-runs.
//
// `injections` is [{ key, after }]: place `xref:<key>.adoc[]` immediately after
// the existing item for `after`, copying that item's depth so it lands as its
// sibling. Both are plan KEYS (`module:stem`, bare for ROOT), which is why the key
// form is Antora's coordinate — the injected line is valid nav AsciiDoc as it
// stands, module and all. A missing anchor THROWS rather than skipping: silently
// doing nothing would leave the page an orphan at the component root, which is
// precisely the state the injection exists to fix, and the caller has already
// established that the page exists in this version.
//
// An injection whose page is ALREADY a nav item is skipped instead, and that is a
// different case from a missing anchor, not a softer one. An orphan disposition
// covers a page across EVERY branch, but a page is only an orphan in the branches
// whose nav omits it: hazelcast:maintain-cluster/rest-api is an orphan from 5.5
// up and already in nav at 5.4 and 5.3, whose nav is organised differently.
// Injecting there would duplicate the entry, and throwing (its anchor
// rest-api-swagger is a page that did not exist before 5.5) would fail the build
// over a version that needs no fix at all. So presence is checked FIRST, and only
// where the page is genuinely missing does the anchor have to be there — which
// leaves a mistyped `nav.after` exactly as loud as it ever was.
function injectNavEntries (adoc, injections) {
  if (!injections || !injections.length) return adoc
  const lines = adoc.split('\n')
  const itemKeyAt = (i) => { const m = lines[i].match(ITEM_RE); return m ? parseTarget(m[2]).key : null }
  const indexOfItem = (key) => lines.findIndex((_, i) => itemKeyAt(i) === key)
  for (const { key, after } of injections) {
    if (indexOfItem(key) !== -1) continue // this version's nav already lists it
    const at = indexOfItem(after)
    if (at === -1) throw new Error(`nav injection for "${key}": anchor item "${after}" not found in nav.adoc`)
    lines.splice(at + 1, 0, `${lines[at].match(ITEM_RE)[1]} xref:${key}.adoc[]`)
  }
  return lines.join('\n')
}

const folderName = (label) => label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const humanize = (stem) => stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Build the plan from a parsed nav tree.
//   titles: Map<key, doctitle> (from the manifest, keyed by the same
//           module-qualified plan key) — used for category labels of parent pages
//           whose nav label is empty, and to decide whether a leaf needs an
//           explicit sidebar_label.
// Returns { pages: Map<key, {relFile, sidebarLabel, sidebarPosition}>,
//           categories: [{relFile, content}], duplicates: [key] }
//
// There is deliberately no `slug` here: a page's slug is the one thing the plan
// must NOT guess, because it is what preserves the published URL. convert.js
// derives it from the page's real URL (urlToSlug), which is the only source that
// carries the module segment a nav-derived guess would drop.
function buildPlan (roots, titles = new Map()) {
  const pages = new Map()
  const categories = []
  const duplicates = []
  // relFile -> the key that claimed it. Two DIFFERENT pages landing on one output
  // file would silently overwrite each other (the second write wins, and the first
  // page's URL is then served by the second page's content). Same-stem pages in
  // different modules make that reachable, so the collision is resolved by
  // qualifying the loser's filename rather than left to the filesystem.
  const takenFiles = new Map()

  // Claim `relFile` for `key`, qualifying it with the module coordinate if another
  // page already holds it. Returns the file actually claimed.
  function claimFile (relFile, key) {
    if (!takenFiles.has(relFile)) { takenFiles.set(relFile, key); return relFile }
    const module = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
    const ext = path.extname(relFile)
    const qualified = path.join(path.dirname(relFile), `${path.basename(relFile, ext)}-${module || 'root'}${ext}`)
    takenFiles.set(qualified, key)
    return qualified
  }

  function categoryFile (relDir, label, position) {
    // link: null makes the category a pure, non-clickable grouping and disables
    // Docusaurus's "category index" convention (a doc whose filename matches its
    // folder would otherwise be auto-adopted as the category's link and vanish
    // as a child item). In the Overview pattern the content always lives in an
    // `overview.mdx` child, never on the category itself.
    categories.push({ relFile: path.join(relDir, '_category_.json'), content: { label: label && foldTypographic(label), position, link: null } })
  }

  // Returns true if this node produced any output (a placed page or an emitted
  // category), false if it collapsed to nothing. A category that adds no new
  // page — because every descendant page is a duplicate already placed at an
  // earlier nav location — must NOT emit an empty _category_.json (an empty,
  // unclickable sidebar group). This happens when a page is listed in a second
  // nav spot (e.g. the versioned operator navs repeat release-notes.adoc under a
  // dedicated `.Release Notes` section); the first placement wins, the second
  // collapses away. The duplicate is still recorded for the caller's report.
  function walk (node, parentDir, position) {
    if (node.type === 'category') {
      const dir = path.join(parentDir, folderName(node.label))
      // Collapse a redundant level: a category whose ONLY child is itself a
      // parent page stacks two groupings for one section (e.g. the category
      // "Organizations and Accounts" wrapping the page of the same name). Merge
      // them — keep the category label, make that page this category's Overview,
      // and lift its children up one level.
      const only = node.children.length === 1 ? node.children[0] : null
      if (only && only.type === 'page' && only.children.length) {
        categoryFile(dir, node.label, position)
        if (!pages.has(only.key)) {
          pages.set(only.key, {
            relFile: claimFile(path.join(dir, 'overview.mdx'), only.key), sidebarLabel: 'Overview', sidebarPosition: 0,
          })
        } else duplicates.push(only.key)
        let i = 1
        for (const grandchild of only.children) walk(grandchild, dir, i++)
        return true
      }
      // Emit the category only if at least one child produces output. Walk the
      // children first (into the shared maps), then decide — _category_.json
      // files are keyed by path, so emitting after the children is harmless.
      let i = 1
      let produced = 0
      for (const child of node.children) if (walk(child, dir, i++)) produced++
      if (produced === 0) return false
      categoryFile(dir, node.label, position)
      return true
    }
    // page
    if (pages.has(node.key)) { duplicates.push(node.key); return false }
    if (node.children.length) {
      // Parent page -> category folder + an Overview page holding its content.
      const dir = path.join(parentDir, node.stem)
      const label = node.label || titles.get(node.key) || humanize(node.stem)
      categoryFile(dir, label, position)
      pages.set(node.key, {
        relFile: claimFile(path.join(dir, 'overview.mdx'), node.key),
        sidebarLabel: 'Overview',
        sidebarPosition: 0,
      })
      let i = 1
      for (const child of node.children) walk(child, dir, i++)
      return true
    }
    // Leaf page.
    const title = titles.get(node.key)
    const sidebarLabel = node.label && node.label !== title ? node.label : null
    pages.set(node.key, {
      relFile: claimFile(path.join(parentDir, node.stem + '.mdx'), node.key),
      sidebarLabel,
      sidebarPosition: position,
    })
    return true
  }

  let i = 1
  for (const root of roots) walk(root, '', i++)
  return { pages, categories, duplicates }
}

// The attribute lookup a nav.adoc is resolved against: the version's own table
// over Asciidoctor's intrinsics (`{cpp}`, `{nbsp}`, `{plus}`, …), which Antora
// resolves in the nav but the manifest never lists. Read from Asciidoctor itself
// rather than copied. Its values are HTML entities (`C&#43;&#43;`) and nothing
// downstream decodes a nav label, so they are decoded here.
let intrinsics
function navAttrLookup (attrs) {
  if (!intrinsics) {
    require('@asciidoctor/core')()
    const table = globalThis.Opal.Asciidoctor.$$const.INTRINSIC_ATTRIBUTES
    intrinsics = Object.fromEntries(table.$keys().map((k) => [k, decodeHTML(table['$[]'](k))]))
  }
  return { ...intrinsics, ...attrs }
}

module.exports = { navAttrLookup, parseNav, buildPlan, injectNavEntries, resolveNavIncludes, parseTarget, pageKey, keyStem, folderName }
