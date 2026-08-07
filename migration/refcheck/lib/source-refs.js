'use strict'

// SOURCE side of the no-baking check: given a page's manifest resource, walk its
// AsciiDoc source (from the frozen mirror) THROUGH its includes and report which
// attribute references ({name}) its rendered form would resolve -- plus the
// example$ includes it pulls in. This is the ground truth the converted MDX is
// checked against: every {name} the source references must survive as a
// reference in the output, never as a baked literal.
//
// Include expansion mirrors how Antora assembles a page: partial$/page$ includes
// are read and scanned recursively (honouring tag slicing), so an attribute
// referenced inside an included partial counts against the including page.
// example$ includes are recorded (for the example-preservation check) and their
// bodies scanned too -- their {name} placeholders stay in the byte-faithful
// example file the converter imports, so they are references, not bakes.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { NAV_SOURCES, refFor } = require('../../lib/layout')
const { wrappableRefs } = require('../../antora-extension/mark-attributes')

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

// Every UNESCAPED {name} reference in a chunk of AsciiDoc. `\{name}` is an
// escaped literal (Asciidoctor drops the backslash, no substitution) so it is
// not a reference. Mirrors plugins/lib/substitute-attributes' matcher.
const REF_RE = /(\\?)\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g
function refsIn (text) {
  const names = new Set()
  let m
  while ((m = REF_RE.exec(text)) !== null) {
    if (m[1]) continue // escaped -> literal, not a reference
    names.add(m[2])
  }
  return names
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

// Collect the attribute references a page resolves, expanding includes.
// Returns { names:Set, examples:[coord…] } where `examples` are the example$
// includes reached (for the example-preservation check). `component`/`seg` scope
// which branch source is read from; `resource` is the manifest page resource
// (component, module, relative).
function collectPageRefs (resource, seg, sourcesDir) {
  const start = { component: resource.component, module: resource.module || 'ROOT', family: 'page', relative: resource.relative }
  const names = new Set()
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
    // Only references in a WRAPPABLE context must be preserved: a reference in a
    // heading (-> frontmatter title / anchor), a :description: entry, image alt,
    // or code is correctly baked, so it is not required to survive. Shared with
    // mark-attributes so the checker expects preservation exactly where the
    // marker pass provides it.
    const all = refsIn(text)
    if (all.size) for (const n of wrappableRefs(text, [...all])) names.add(n)
    for (const inc of includesIn(text)) {
      const child = resolveTarget(inc.target, coord)
      if (!child) continue
      if (child.family === 'example') { examples.push(child); walk(child, inc.tag); continue }
      walk(child, inc.tag)
    }
  }

  walk(start, null)
  return { names, examples }
}

module.exports = { collectPageRefs, refsIn, includesIn, resolveTarget, locate, sliceByTags, stripComments }
