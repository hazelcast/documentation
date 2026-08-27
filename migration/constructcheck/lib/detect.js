'use strict'

// Construct detectors for the coverage gate. Two passes, matching the two-layer
// census that motivated this gate:
//   * lexical -- directives, macros, block delimiters, bracket styles, source
//     languages, conditionals, subs overrides, passthrough (line-oriented).
//   * ast     -- block contexts / styles / roles / source-languages read from
//     Asciidoctor's parsed tree, i.e. the semantic constructs a line scan cannot
//     see (an open block used as an admonition, a description/qanda/glossary
//     list, collapsible/tabs examples, graphviz literal blocks).
//
// A "construct" is keyed `category:token`, where two occurrences share a key
// exactly when they go through the SAME converter handling. Attribute REFERENCES
// are collapsed to one token (`attr-reference:{…}`): every {name} shares the one
// variableise mechanism and is already gated per-name by refcheck, so listing
// 180-odd names here would be redundant noise. Conditionals, includes, macros,
// block styles and languages stay per-token because each maps to distinct
// handling.
//
// Detectors only IDENTIFY constructs; they never decide handling. Whether a
// construct is handled is the manual audit's job (the gate just refuses to
// assume it). Coordinate fragments of an `xref:`/`include::` target (`query:` in
// `xref:query:foo.adoc[]`) are NOT macros and are suppressed at the source here
// so the gate reports constructs, not parser artefacts.

const { execFileSync } = require('node:child_process')

let _adoc = null
function asciidoctor () {
  if (_adoc === null) {
    _adoc = require('@asciidoctor/core')()
    _adoc.LoggerManager.setLogger(_adoc.MemoryLogger.create()) // swallow unresolved-include warnings
  }
  return _adoc
}

// Read one source file from a mirror at a ref; null if absent on that branch.
// (Kept local rather than imported so refcheck's internals stay untouched.)
function gitShow (repoDir, ref, repoPath) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${repoPath}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

const RE_COND = /^(ifdef|ifndef|ifeval)::([^[]*)\[/
const RE_ENDIF = /^endif::/
const RE_INCLUDE = /^\s*include::([^[\s]+)\[/
const RE_BLOCKMAC = /^([a-z][a-z0-9_-]*)::([^[\s]*)\[/
const RE_SOURCELANG = /^\[source%?,\s*([A-Za-z0-9_+#.-]+)|^\[,\s*([A-Za-z0-9_+#.-]+)/
const RE_BRACKET = /^\[(.+)\]\s*$/
const RE_SUBS = /^\[.*\bsubs=/
// Inline macro: NAME:target[…]. The lookbehind rejects a coordinate segment that
// is not the macro name, so `xref:` is a macro but the `query:` in
// `xref:query:foo[]` is not. It has to reject THREE preceding characters:
//   `:`  the ordinary `component:module:page` chain (`query:` above);
//   `@`  the VERSION PIN, `{page-latest-supported-hazelcast}@hazelcast:deploy:x.adoc`
//        — without `@` listed, the component name reads as a macro called
//        `hazelcast:` (found on management-center getting-started/overview);
//   alphanumerics, which keep `foo bar:baz[` from matching mid-word.
const RE_INLINEMAC = /(?<![A-Za-z0-9:@-])([a-z][a-z0-9_-]*):(?!:)([^\s[]*)\[/g
const RE_PASS = /pass:\w*\[/
// A block delimiter line. Two forms: a run of the same delimiter char (`----`,
// `====`, `****`, `____`, `....`, `++++`, `////`) or the open block `--`; PLUS a
// table delimiter (`|===`, `!===`), which is a pipe/bang followed by `===` and
// so does NOT fit the same-char-run alternative. Without the `[|!]={3,}` branch
// a table line matches nothing and the FENCE `table`/`nested-table` entries are
// unreachable (lexical table detection silently no-ops).
const RE_FENCE = /^(?:([-=*_.+/|!])\1{1,}|--|[|!]={3,})\s*$/
const IGNORE_INLINE = new Set(['http', 'https', 'ftp', 'irc', 'mailto'])
const FENCE = {
  '----': 'listing', '====': 'example', '****': 'sidebar', '____': 'quote',
  '....': 'literal', '++++': 'passthrough', '////': 'comment', '|===': 'table',
  '!===': 'nested-table', '--': 'open',
}

function includeFamily (target) {
  const t = target.trim()
  if (t.includes('$')) {
    const coord = t.slice(0, t.indexOf('$'))
    const family = coord.split(':').pop()
    return family + (coord.includes(':') || coord.includes('@') ? ' [x-comp]' : '')
  }
  return 'relative' + (t.includes(':') || t.includes('@') ? ' [x-comp]' : '')
}

// Lexical constructs in a chunk of AsciiDoc. Returns [{category, token, line, raw}].
function detectLexical (text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]
    const push = (category, token) => out.push({ category, token, line: i + 1, raw: s.trim().slice(0, 100) })

    let m = s.match(RE_COND)
    if (m) { push('conditional', `${m[1]}::${m[2]}`); continue }
    if (RE_ENDIF.test(s)) { push('conditional', 'endif::'); continue }

    m = s.match(RE_INCLUDE)
    if (m) push('include', includeFamily(m[1]))

    m = s.match(RE_BLOCKMAC)
    if (m && !['include', 'ifdef', 'ifndef', 'ifeval', 'endif'].includes(m[1])) push('block-macro', `${m[1]}::`)

    m = s.match(RE_SOURCELANG)
    if (m) push('source-language', (m[1] || m[2]))

    if (RE_SUBS.test(s)) push('subs-override', s.trim().slice(0, 40))

    const fm = s.match(RE_FENCE)
    if (fm) {
      const t = s.trim()
      const key = t.startsWith('|===') ? '|===' : t.startsWith('!===') ? '!===' : t === '--' ? '--' : t.slice(0, 4)
      push('delimited-block', FENCE[key] || key)
    }

    const mb = s.match(RE_BRACKET)
    if (mb && !RE_SOURCELANG.test(s) && !RE_SUBS.test(s)) {
      const inner = mb[1]
      let tok
      if (inner.startsWith('%')) tok = `%${inner.slice(1).split(',')[0]}`
      else if (inner.startsWith('.')) tok = '.role'
      else if (inner.startsWith('#') || inner.startsWith('[')) tok = 'anchor'
      else tok = inner.split(',')[0].split('%')[0].split('#')[0].split('.')[0].trim()
      if (tok) push('bracket-style', tok)
    }

    RE_INLINEMAC.lastIndex = 0
    let im
    while ((im = RE_INLINEMAC.exec(s)) !== null) {
      if (!IGNORE_INLINE.has(im[1])) push('inline-macro', `${im[1]}:`)
    }
    if (RE_PASS.test(s)) push('passthrough', 'pass:[…]')
  }
  return out
}

// AST-level block constructs. Best-effort: never throws (a mis-parsed fragment
// just yields fewer constructs; a deny-all gate tolerates over- and under-report
// equally, since both only ever ADD things to classify).
function detectAst (text) {
  const out = []
  let doc
  try { doc = asciidoctor().load(text, { safe: 'safe' }) } catch { return out }
  const visit = (node) => {
    let blocks = []
    try { blocks = node.getBlocks ? node.getBlocks() : [] } catch { blocks = [] }
    for (const b of blocks) {
      if (!b || !b.getContext) continue // array[2] dlist term/desc tuples etc.
      let ctx = '?'; let style = null; let roles = []
      try { ctx = String(b.getContext()) } catch {}
      try { style = b.getStyle ? b.getStyle() : null } catch {}
      try { roles = b.getRoles ? (b.getRoles() || []) : [] } catch {}
      out.push({ category: 'ast-context', token: ctx })
      if (style && style !== ctx) out.push({ category: 'ast-style', token: `${ctx}:${style}` })
      for (const r of roles) out.push({ category: 'ast-role', token: r })
      try {
        if (ctx === 'listing' && b.getAttribute && b.getAttribute('language')) {
          out.push({ category: 'source-language', token: String(b.getAttribute('language')) })
        }
      } catch {}
      visit(b)
    }
  }
  visit(doc)
  return out
}

module.exports = { detectLexical, detectAst, gitShow }
