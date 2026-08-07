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
// no snapshot conditional.
function wrapConditionals (text) {
  if (!text.includes('ifdef::snapshot[]')) return text
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== 'ifdef::snapshot[]') { out.push(line); continue }
    // Find the matching endif (bare or named). No nesting in scope.
    let j = i + 1
    while (j < lines.length && !/^\s*endif::(?:snapshot)?\[\]\s*$/.test(lines[j])) j++
    if (j >= lines.length) { out.push(line); continue } // unterminated: leave as-is
    out.push(line) // ifdef::snapshot[]
    out.push('', pass(START), '')
    for (let k = i + 1; k < j; k++) out.push(lines[k])
    out.push('', pass(END), '')
    out.push(lines[j]) // endif
    i = j
  }
  return out.join('\n')
}

// Strip the rendered sentinel comments, reproducing the un-instrumented golden
// byte-for-byte. Writer (wrapConditionals) and matcher must stay in lockstep.
// The passthrough emits the bare comment on its own line; drop that line incl.
// its trailing newline (mirrors mark-partials' SENTINEL_RE).
const SENTINEL_RE = /^<!--hz-if:snapshot:(?:start|end)-->\n?/gm
const stripConditionalSentinels = (html) => html.replace(SENTINEL_RE, '')

module.exports = { wrapConditionals, stripConditionalSentinels, SENTINEL_RE, START, END }
