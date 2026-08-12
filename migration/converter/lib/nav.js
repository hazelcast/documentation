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

const CATEGORY_RE = /^\.(\S.*)$/
const ITEM_RE = /^(\*+)\s+xref:([^[\]]+?)\[(.*)\]\s*$/
// A bullet item with no xref -> a grouping (sub-category). Captures the depth and
// the label text. Tested only after ITEM_RE fails, so it never eats a page item.
const GROUP_RE = /^(\*+)\s+(\S.*?)\s*$/

// A nav xref target -> the page stem (cloud is single-module + flat, so the
// stem is the last path/colon segment with .adoc and any #fragment removed).
function targetStem (target) {
  return target.trim().replace(/#.*$/, '').replace(/\.adoc$/, '').split(/[:/]/).pop()
}

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
      const node = { type: 'page', stem: targetStem(item[2]), label: item[3].trim(), children: [] }
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

const folderName = (label) => label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const humanize = (stem) => stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Build the plan from a parsed nav tree.
//   titles: Map<stem, doctitle> (from the manifest) — used for category labels
//           of parent pages whose nav label is empty, and to decide whether a
//           leaf needs an explicit sidebar_label.
// Returns { pages: Map<stem, {relFile, slug, sidebarLabel, sidebarPosition}>,
//           categories: [{relFile, content}], duplicates: [stem] }
function buildPlan (roots, titles = new Map()) {
  const pages = new Map()
  const categories = []
  const duplicates = []

  function categoryFile (relDir, label, position) {
    // link: null makes the category a pure, non-clickable grouping and disables
    // Docusaurus's "category index" convention (a doc whose filename matches its
    // folder would otherwise be auto-adopted as the category's link and vanish
    // as a child item). In the Overview pattern the content always lives in an
    // `overview.mdx` child, never on the category itself.
    categories.push({ relFile: path.join(relDir, '_category_.json'), content: { label, position, link: null } })
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
        if (!pages.has(only.stem)) {
          pages.set(only.stem, {
            relFile: path.join(dir, 'overview.mdx'), slug: '/' + only.stem, sidebarLabel: 'Overview', sidebarPosition: 0,
          })
        } else duplicates.push(only.stem)
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
    if (pages.has(node.stem)) { duplicates.push(node.stem); return false }
    if (node.children.length) {
      // Parent page -> category folder + an Overview page holding its content.
      const dir = path.join(parentDir, node.stem)
      const label = node.label || titles.get(node.stem) || humanize(node.stem)
      categoryFile(dir, label, position)
      pages.set(node.stem, {
        relFile: path.join(dir, 'overview.mdx'),
        slug: '/' + node.stem,
        sidebarLabel: 'Overview',
        sidebarPosition: 0,
      })
      let i = 1
      for (const child of node.children) walk(child, dir, i++)
      return true
    }
    // Leaf page.
    const title = titles.get(node.stem)
    const sidebarLabel = node.label && node.label !== title ? node.label : null
    pages.set(node.stem, {
      relFile: path.join(parentDir, node.stem + '.mdx'),
      slug: '/' + node.stem,
      sidebarLabel,
      sidebarPosition: position,
    })
    return true
  }

  let i = 1
  for (const root of roots) walk(root, '', i++)
  return { pages, categories, duplicates }
}

module.exports = { parseNav, buildPlan, targetStem, folderName }
