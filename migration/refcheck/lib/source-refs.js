'use strict'

// SOURCE-side include walker. Two consumers, both needing the same thing -- the
// set of source files a page actually reaches:
//   - refcheck, for the `example$` includes a page pulls in (the
//     example-preservation check);
//   - the converter, for the verbatim-block LINES in that closure that carry an
//     `{attribute}` (converter/lib/code-templates.js). A partial's code lines are
//     why the closure matters rather than just the page file: hazelcast's
//     get-started-cli pulls its brew/apt/yum commands in from install-hazelcast,
//     and those name `{os-version}` -- indistinguishable, by value, from the
//     `{full-version}` the page itself references.
//
// It used to collect attribute references too, and that was the checker's weak
// point: reading AsciiDoc with regexes means approximating tag-slice wildcards,
// ifdefs and nested attribute expansion, and an approximate scan can only support
// a per-page yes/no question, never a count. Attribute expectations now come from
// the CENSUS render instead (refcheck/lib/census-ledger.js), where Asciidoctor
// has already done all of that resolution exactly. What remains here is the
// narrower job the census does not cover: which example files a page includes.
//
// Include expansion mirrors how Antora assembles a page: partial$/page$ includes
// are read and walked recursively (honouring tag slicing), so an example pulled
// in through a partial still counts against the including page.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { NAV_SOURCES, refFor } = require('../../lib/layout')
// The same substituter the converter and <Variable> use, for `{attr}`s in an
// include target (Antora substitutes them there).
const substitute = require('../../../plugins/lib/substitute-attributes')

const FAMILY_DIR = { page: 'pages', partial: 'partials', example: 'examples' }

// Read one source file from a mirror at a ref. Returns null if it does not exist
// on that branch (a version-specific partial absent from an older release, etc.).
function gitShow (repoDir, ref, repoPath) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${repoPath}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

// Strip AsciiDoc comments so a {ref} that only appears in a comment is not
// counted: block comments (//// … ////) and single-line // comments. Conservative
// -- it never removes content, only comment lines.
function stripComments (text) {
  const out = []
  let inBlock = false
  for (const line of text.split('\n')) {
    if (/^\/{4,}\s*$/.test(line)) { inBlock = !inBlock; continue }
    if (inBlock) continue
    if (/^\/\//.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

// Slice a file to the regions selected by an include's tag spec (tag=NAME or
// tags=a;b). Antora/Asciidoctor tag markers are `// tag::NAME[]` … `// end::NAME[]`.
// Negations (!name) and the `**`/`*` wildcards are treated as "keep everything"
// for our purposes (we only need a superset of the referenced names, and the
// exact selection never REMOVES a name that is genuinely on the page). Returns
// the whole text when there is no positive tag selection.
function sliceByTags (text, tagSpec) {
  if (!tagSpec) return text
  const wanted = tagSpec.split(/[;,]/).map((t) => t.trim()).filter((t) => t && !t.startsWith('!') && t !== '*' && t !== '**')
  if (!wanted.length) return text
  const want = new Set(wanted)
  const lines = text.split('\n')
  const out = []
  const active = new Set()
  const TAG = /^\s*(?:\/\/|#|;;|--)\s*(tag|end)::([A-Za-z0-9_-]+)\[\]\s*$/
  for (const line of lines) {
    const t = line.match(TAG)
    if (t) {
      if (t[1] === 'tag' && want.has(t[2])) active.add(t[2])
      else if (t[1] === 'end') active.delete(t[2])
      continue
    }
    if (active.size) out.push(line)
  }
  return out.join('\n')
}

// Parse `include::TARGET[OPTS]` lines out of a chunk. Returns { target, tag }.
const INCLUDE_LINE = /^\s*include::([^[\s]+)\[([^\]]*)\]/gm
function includesIn (text) {
  const out = []
  let m
  while ((m = INCLUDE_LINE.exec(text)) !== null) {
    const opts = m[2] || ''
    const tm = opts.match(/\btags?=([^,\]]+)/)
    out.push({ target: m[1], tag: tm ? tm[1] : null })
  }
  return out
}

// Resolve an include TARGET to a { component, module, family, relative } coord,
// defaulting bare coordinates to the including resource's own component/module.
// Returns null for targets we do not resolve (unknown family, or a component
// with no source mirror -- e.g. a cross-component imdg include).
function resolveTarget (target, from) {
  // A leading `version@`. Recorded rather than dropped: a cross-component include
  // names the version it wants (`{page-latest-supported-mc}@management-center:…`),
  // and reading `from`'s branch instead finds nothing at all.
  const at = target.indexOf('@')
  let t = target
  let version = null
  if (at !== -1 && /^[\w.{}-]+$/.test(target.slice(0, at))) {
    version = target.slice(0, at)
    t = target.slice(at + 1)
  }

  const dollar = t.indexOf('$')
  if (dollar === -1) {
    if (!t.endsWith('.adoc')) return null
    const parts = t.split(':')
    if (parts.length === 1) {
      // Bare relative include -> including file's family, resolved against its dir.
      const relative = path.posix.join(path.posix.dirname(from.relative), t)
      return { component: from.component, module: from.module, family: from.family, version, relative }
    }
    // MODULE- (and optionally component-) qualified with NO family, e.g.
    // `include::deploy:enterprise-licenses.adoc[tag=install-license]`. Antora's
    // resource-id rules default the family to the INCLUDING file's, and resolve
    // `relative` against that family's dir rather than the including file's dir --
    // so this cannot go through the bare-relative branch above, which is what it
    // used to do. Reading it as a sibling path meant the file was never opened, and
    // every reference it carried was invisible: install-enterprise's
    // `setLicenseKey()` javadoc link, clients/java's maven `<version>`, and
    // get-started-enterprise's docker tags all reach their pages this way.
    const relative = parts[parts.length - 1]
    const module = parts[parts.length - 2] || from.module || 'ROOT'
    const component = parts.length >= 3 ? (parts[parts.length - 3] || from.component) : from.component
    if (!NAV_SOURCES[component]) return null
    return { component, module, family: from.family, version, relative }
  }
  const coord = t.slice(0, dollar)
  const relative = t.slice(dollar + 1)
  const parts = coord.split(':')
  const family = parts[parts.length - 1]
  if (!FAMILY_DIR[family]) return null
  let component = from.component
  let module = from.module || 'ROOT'
  if (parts.length === 2) module = parts[0] || module
  else if (parts.length >= 3) { component = parts[parts.length - 3] || component; module = parts[parts.length - 2] || module }
  if (!NAV_SOURCES[component]) return null // no mirror for this component (resolution-only)
  return { component, module, family, version, relative }
}

// The mirror repo dir + branch + in-repo path for a resolved coord at `seg`.
function locate (coord, seg, sourcesDir) {
  const src = NAV_SOURCES[coord.component]
  if (!src) return null
  const modulesRoot = path.posix.dirname(path.posix.dirname(src.file)) // docs/modules
  const repoPath = path.posix.join(modulesRoot, coord.module || 'ROOT', FAMILY_DIR[coord.family], coord.relative)
  // A coord carrying its own version wins: `seg` is the INCLUDING page's version,
  // which is meaningless for a cross-component include. An unresolved `{attr}`
  // version is no use either, so those fall back to `seg` and simply find nothing.
  const wanted = coord.version && !coord.version.includes('{') ? coord.version : seg
  return { repoDir: path.join(sourcesDir, src.repo), ref: refFor(coord.component, wanted), repoPath }
}

// Read-through cache for the source files the walk touches: a shared partial is
// included by dozens of pages, and every hit is otherwise a `git show` process.
// Safe because the mirrors are frozen for the life of a run (see migration/README).
const textCache = new Map()
function cachedText (loc) {
  const key = `${loc.repoDir}\u0000${loc.ref}\u0000${loc.repoPath}`
  if (!textCache.has(key)) textCache.set(key, gitShow(loc.repoDir, loc.ref, loc.repoPath))
  return textCache.get(key)
}

// Walk a page's include closure, calling `visit(coord, text)` for the page itself
// and for every file it reaches, with that file's text already comment-stripped
// and tag-sliced exactly as Antora slices it. `seg` scopes which branch is read;
// `resource` is the manifest page resource (component, module, relative).
// `attrs` (optional) resolves `{name}` in an include TARGET before it is parsed --
// Antora substitutes attributes there, and hazelcast's get-started-cli relies on it:
// `include::{page-latest-supported-mc}@management-center:getting-started:install.adoc[tag=cli]`
// names the MC version it wants. Without the substitution the version stays a brace
// expression, locate falls back to the including page's seg, and the file is missed.
function walkPageSources (resource, seg, sourcesDir, visit, attrs = null) {
  const start = { component: resource.component, module: resource.module || 'ROOT', family: 'page', relative: resource.relative }
  const visited = new Set()

  const walk = (coord, tag) => {
    const loc = locate(coord, seg, sourcesDir)
    if (!loc) return
    const key = `${loc.ref}:${loc.repoPath}${tag ? '#' + tag : ''}`
    if (visited.has(key)) return
    visited.add(key)
    const raw = cachedText(loc)
    if (raw == null) return
    const text = stripComments(sliceByTags(raw, tag))
    visit(coord, text)
    for (const inc of includesIn(text)) {
      const child = resolveTarget(attrs ? substitute(inc.target, attrs) : inc.target, coord)
      if (!child) continue
      walk(child, inc.tag)
    }
  }

  walk(start, null)
}

// The `example$` includes a page reaches.
function collectPageExamples (resource, seg, sourcesDir) {
  const examples = []
  walkPageSources(resource, seg, sourcesDir, (coord) => {
    if (coord.family === 'example') examples.push(coord)
  })
  return examples
}

// Every source text a page reaches, page first. The converter feeds this to
// attrCodeTemplates so a partial's code lines are templated against the page that
// includes them.
function collectPageTexts (resource, seg, sourcesDir, attrs = null) {
  const texts = []
  walkPageSources(resource, seg, sourcesDir, (_coord, text) => texts.push(text), attrs)
  return texts
}

module.exports = {
  collectPageExamples, collectPageTexts, walkPageSources,
  includesIn, resolveTarget, locate, sliceByTags, stripComments,
}
