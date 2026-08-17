'use strict'

// SOURCE-side include walker, used ONLY to find the `example$` includes a page
// pulls in (for the example-preservation check).
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
  // Drop a leading `version@` (we always read `from`'s branch).
  const at = target.indexOf('@')
  let t = target
  if (at !== -1 && target.slice(0, at).match(/^[\w.-]+$/) && target.indexOf('$') > at) t = target.slice(at + 1)

  const dollar = t.indexOf('$')
  if (dollar === -1) {
    // Bare relative include -> including file's family, resolved against its dir.
    if (!t.endsWith('.adoc')) return null
    const relative = path.posix.join(path.posix.dirname(from.relative), t)
    return { component: from.component, module: from.module, family: from.family, relative }
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
  return { component, module, family, relative }
}

// The mirror repo dir + branch + in-repo path for a resolved coord at `seg`.
function locate (coord, seg, sourcesDir) {
  const src = NAV_SOURCES[coord.component]
  if (!src) return null
  const modulesRoot = path.posix.dirname(path.posix.dirname(src.file)) // docs/modules
  const repoPath = path.posix.join(modulesRoot, coord.module || 'ROOT', FAMILY_DIR[coord.family], coord.relative)
  return { repoDir: path.join(sourcesDir, src.repo), ref: refFor(coord.component, seg), repoPath }
}

// Collect the `example$` includes a page reaches, expanding partial$/page$
// includes on the way. `seg` scopes which branch source is read from; `resource`
// is the manifest page resource (component, module, relative).
function collectPageExamples (resource, seg, sourcesDir) {
  const start = { component: resource.component, module: resource.module || 'ROOT', family: 'page', relative: resource.relative }
  const examples = []
  const visited = new Set()

  const walk = (coord, tag) => {
    const loc = locate(coord, seg, sourcesDir)
    if (!loc) return
    const key = `${loc.ref}:${loc.repoPath}${tag ? '#' + tag : ''}`
    if (visited.has(key)) return
    visited.add(key)
    let text = gitShow(loc.repoDir, loc.ref, loc.repoPath)
    if (text == null) return
    text = stripComments(sliceByTags(text, tag))
    for (const inc of includesIn(text)) {
      const child = resolveTarget(inc.target, coord)
      if (!child) continue
      if (child.family === 'example') { examples.push(child); walk(child, inc.tag); continue }
      walk(child, inc.tag)
    }
  }

  walk(start, null)
  return examples
}

module.exports = { collectPageExamples, includesIn, resolveTarget, locate, sliceByTags, stripComments }
