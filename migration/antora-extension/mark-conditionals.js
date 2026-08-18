'use strict'

// Source-text marker for AsciiDoc `ifdef::snapshot[]…endif::[]` conditionals,
// the sibling of mark-attributes.js (also a pre-render TEXT rewrite, so it runs
// BEFORE Asciidoctor's preprocessor resolves the conditional — a tree-processor
// like mark-partials cannot, since the ifdef is gone by parse time).
//
// It injects passthrough HTML-comment sentinels INSIDE the ifdef block, keeping
// the `ifdef::snapshot[]` directive intact:
//
//   ifdef::snapshot[]
//   ++++
//   <!--hz-if:snapshot:start-->
//   ++++
//   …block content…
//   ++++
//   <!--hz-if:snapshot:end-->
//   ++++
//   endif::[]
//
// Because the sentinels sit inside the conditional, they are included/excluded
// with it: a version where `snapshot` is set renders `<!--hz-if:snapshot:start-->
// …content… <!--hz-if:snapshot:end-->` into the golden; a version where it is
// not renders nothing. The converter turns a marked region into `<IfSnapshot>`
// (only for the current/snapshot tree — the sole `docusaurus docs:version`
// cut-source); readGolden strips the comment lines, reproducing the
// un-instrumented golden byte-for-byte, so the fidelity baseline is unaffected.
//
// v1 scope: `snapshot` only, BLOCK form (`ifdef::snapshot[]` on its own line
// paired with the next `endif`), no nesting — matches the operator corpus (one
// block). Inline `ifdef::snapshot[text]` and other flags are later extensions.

const START = '<!--hz-if:snapshot:start-->'
const END = '<!--hz-if:snapshot:end-->'
const pass = (comment) => `++++\n${comment}\n++++`

// Rewrite one source file's text: inject sentinels inside each block-form
// `ifdef::snapshot[]…endif::[]`. Line-based (mirrors mark-attributes' transform)
// so it is robust to the block content. Returns the text unchanged when there is
// no snapshot conditional. `stats`, if given, counts {marked, skipped}.
//
// A block is only marked where the injection is provably parse-neutral (see
// canMark). Marking is an optimisation — it buys `<IfSnapshot>` instead of a baked
// region — whereas byte-faithfulness of the golden is the contract, so a block
// that cannot be marked safely is left alone and simply bakes.
function wrapConditionals (text, stats) {
  if (!text.includes('ifdef::snapshot[]')) return text
  const lines = text.split('\n')
  const out = []
  const count = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1 }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== 'ifdef::snapshot[]') { out.push(line); continue }
    // Find the matching endif (bare or named). No nesting in scope.
    let j = i + 1
    while (j < lines.length && !/^\s*endif::(?:snapshot)?\[\]\s*$/.test(lines[j])) j++
    if (j >= lines.length) { out.push(line); continue } // unterminated: leave as-is
    if (!canMark(lines, i, j)) {
      count('skipped')
      out.push(line)
      continue // body/endif are copied by the ordinary path
    }
    count('marked')
    out.push(line) // ifdef::snapshot[]
    out.push('', pass(START), '')
    for (let k = i + 1; k < j; k++) out.push(lines[k])
    out.push('', pass(END), '')
    out.push(lines[j]) // endif
    i = j
  }
  return out.join('\n')
}

// Is injecting a blank-line-padded passthrough block just inside this
// `ifdef`/`endif` pair parse-neutral?
//
// An `ifdef` directive is INVISIBLE to the block parser — a paragraph can run
// straight through it — so the padded sentinel we inject is the first thing on
// either side that ends a block. Where the source relies on that transparency,
// injecting changes the parse and the "instrumented golden strips back to the
// clean golden" invariant fails.
//
// That is not theoretical: management-center's install.adoc has
//
//   To install on Linux, you can use either of these package managers…:
//   ifdef::snapshot[]
//   .Debian
//
// with no blank line, so Asciidoctor really does absorb `.Debian` into the
// paragraph (a source defect, visible on the live site as a stray ".Debian").
// Injecting a sentinel ended the paragraph and promoted `.Debian` to the block
// title it was meant to be — a *better* render, and therefore a broken baseline.
//
// The requirement is symmetric: the line before the `ifdef` must already end a
// block (blank, or start of file), and so must the line after the `endif`.
function canMark (lines, ifdefAt, endifAt) {
  const boundaryBefore = ifdefAt === 0 || lines[ifdefAt - 1].trim() === ''
  const boundaryAfter = endifAt === lines.length - 1 || lines[endifAt + 1].trim() === ''
  return boundaryBefore && boundaryAfter
}

// Strip the rendered sentinel comments, reproducing the un-instrumented golden
// byte-for-byte. Writer (wrapConditionals) and matcher must stay in lockstep.
// The passthrough emits the bare comment on its own line; drop that line incl.
// its trailing newline (mirrors mark-partials' SENTINEL_RE).
const SENTINEL_RE = /^<!--hz-if:snapshot:(?:start|end)-->\n?/gm
const stripConditionalSentinels = (html) => html.replace(SENTINEL_RE, '')

module.exports = { wrapConditionals, canMark, stripConditionalSentinels, SENTINEL_RE, START, END }
