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
// The ELSE branch (`ifndef::snapshot[]`) gets its own sentinel pair, so the
// converter can tell the two apart and emit <IfSnapshot> vs <IfNotSnapshot>.
const NOT_START = '<!--hz-ifnot:snapshot:start-->'
const NOT_END = '<!--hz-ifnot:snapshot:end-->'
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
// One branch of a conditional: the directive line, its `endif`, and which
// sentinel pair it takes. `ifndef::snapshot[]` is the ELSE branch — content the
// released versions show and the snapshot version hides — and it is the common
// shape, not an afterthought: across the live branches 38 of 41 `ifdef`s are one
// half of an `ifdef`/`ifndef` pair.
const DIRECTIVE = /^(ifdef|ifndef)::snapshot\[\]$/
const ENDIF = /^\s*endif::(?:snapshot)?\[\]\s*$/
const sentinelsFor = (kind) => (kind === 'ifdef' ? [START, END] : [NOT_START, NOT_END])

// The branches starting at line `i`, as ONE unit: a lone `ifdef`/`ifndef`, or the
// `ifdef…endif` + `ifndef…endif` pair when the second directive follows the first
// `endif` immediately. Returns null if line `i` is not a directive (or is
// unterminated). Grouping matters for canMark: the interior of a pair has no
// blank line by construction, so testing each half separately rejects the whole
// idiom, while the pair's OUTER boundaries are usually clean.
function branchesAt (lines, i) {
  const m = (lines[i] || '').trim().match(DIRECTIVE)
  if (!m) return null
  const endOf = (from) => {
    let j = from + 1
    while (j < lines.length && !ENDIF.test(lines[j])) j++
    return j < lines.length ? j : -1
  }
  const end = endOf(i)
  if (end === -1) return null // unterminated: leave the whole thing alone
  const branches = [{ kind: m[1], start: i, end }]
  const next = (lines[end + 1] || '').trim().match(DIRECTIVE)
  if (next && next[1] !== m[1]) {
    const end2 = endOf(end + 1)
    if (end2 !== -1) branches.push({ kind: next[1], start: end + 1, end: end2 })
  }
  return branches
}

function wrapConditionals (text, stats) {
  if (!/^ifn?def::snapshot\[\]$/m.test(text)) return text
  const lines = text.split('\n')
  const out = []
  const count = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1 }
  for (let i = 0; i < lines.length; i++) {
    const branches = branchesAt(lines, i)
    if (!branches) { out.push(lines[i]); continue }
    const last = branches[branches.length - 1]
    const why = markability(lines, i, last.end)
    if (!why) {
      count('skipped')
      out.push(lines[i])
      continue // body/endif are copied by the ordinary path
    }
    count(why === 'neutral' ? 'marked' : 'markedPromotingTitle')
    for (const b of branches) {
      const [open, close] = sentinelsFor(b.kind)
      out.push(lines[b.start]) // ifdef::snapshot[] / ifndef::snapshot[]
      out.push('', pass(open), '')
      for (let k = b.start + 1; k < b.end; k++) out.push(lines[k])
      out.push('', pass(close), '')
      out.push(lines[b.end]) // endif
    }
    i = last.end
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
//
// `endifAt` is the LAST endif of the unit — for a pair, the boundaries that matter
// are the pair's outer ones. Its interior never has a blank line (the second
// directive follows the first `endif` immediately), so testing the halves
// separately would reject the idiom that 38 of 41 live `ifdef`s use.
//
// A `//` LINE COMMENT is deliberately NOT looked through, even though the
// preprocessor drops it without ending a block — so `// tag::name[]` directly
// above a directive (hz-docs' habit, and the reason 30 of its 33 conditionals are
// unmarked) reads as "no boundary" and the unit bakes.
//
// Looking through it was built and then REVERTED, because a blank line above the
// comment is not sufficient either. hz-docs' `install-enterprise.adoc` has
// `// tag::download-package-ee[]` above a pair whose then-branch is a LIST ITEM
// (`. Download and extract…`) in a list that continues past the conditional.
// Marking there is parse-neutral by the blank-line test and still wrong: the
// padded passthrough closes the `<ol>` and the following items restart in a new
// one. Proven on the real corpus — rendering all 6499 pages marked and bare and
// diffing through stripConditionalSentinels found exactly that page.
//
// So comment-transparency needs a LIST-CONTEXT guard alongside it, and belongs
// with the Platform migration where hz-docs pages are converted and the gates can
// see the result. Nothing in the migrated set needs it: management-center's
// conditionals have no tag comments.
// A line that ENDS whatever block is open, so nothing can continue across it: any
// block delimiter, including the open block `--` and a table's `|===`. After such
// a line the hazard boundaryAfter guards against cannot arise, so it counts as a
// boundary even though it is not blank. management-center's install.adoc needs
// this: its conditional pair is the last thing inside a list item's open block, so
// the line after the final `endif::[]` is `--`.
const ENDS_BLOCK = /^(?:--|-{4,}|={4,}|\*{4,}|_{4,}|\.{4,}|\+{4,}|\/{4,}|[|!]===)$/

// A block title (`.Debian`) — the first line of a branch whose preceding paragraph
// has absorbed it. See canMark's `promotesTitle`.
const BLOCK_TITLE = /^\.[^.\s]/

// Is injecting a blank-line-padded passthrough block just inside this unit
// parse-neutral — or, in one named case, changing the parse for the better?
//
// Returns null when marking is unsafe, else a reason string: 'neutral', or
// 'promotes-title' for the case below, which the caller counts separately because
// it makes the golden diverge from Antora deliberately.
function markability (lines, ifdefAt, endifAt) {
  const after = endifAt === lines.length - 1 ? '' : lines[endifAt + 1].trim()
  const boundaryAfter = after === '' || ENDS_BLOCK.test(after)
  if (!boundaryAfter) return null

  const before = ifdefAt === 0 ? '' : lines[ifdefAt - 1].trim()
  if (before === '') return 'neutral'

  // The SWALLOWED BLOCK TITLE case. `ifdef` is invisible to the block parser, so a
  // paragraph immediately above it absorbs the branch's first line — and when that
  // line is a block title, Asciidoctor renders it as stray paragraph text. This is
  // exactly management-center install.adoc's "…depending on your Linux
  // distribution: .Debian", visible on the live site today.
  //
  // Injecting here ends the paragraph and promotes `.Debian` to the block title it
  // was written as, so the render CHANGES — deliberately, and only in that one
  // respect. Marking anyway is the same call already taken for the same species of
  // defect by the converter's fixSwallowedBlockTitles (operator's dangling `+
  // .For Openshift`), whose fidelity diffs are accepted as `upstream`. The
  // alternative is leaving the branch baked, which costs version-cut safety —
  // install.adoc's snapshot half tells readers to install the UNPINNED package, so
  // a cut would ship that on a release.
  const firstInBranch = (lines[ifdefAt + 1] || '').trim()
  if (BLOCK_TITLE.test(firstInBranch)) return 'promotes-title'
  return null
}

const canMark = (lines, ifdefAt, endifAt) => markability(lines, ifdefAt, endifAt) !== null

// Strip the rendered sentinel comments, reproducing the un-instrumented golden
// byte-for-byte. Writer (wrapConditionals) and matcher must stay in lockstep.
// The passthrough emits the bare comment on its own line; drop that line incl.
// its trailing newline (mirrors mark-partials' SENTINEL_RE).
const SENTINEL_RE = /^<!--hz-if(?:not)?:snapshot:(?:start|end)-->\n?/gm
const stripConditionalSentinels = (html) => html.replace(SENTINEL_RE, '')

module.exports = {
  wrapConditionals, canMark, markability, branchesAt, stripConditionalSentinels, SENTINEL_RE,
  START, END, NOT_START, NOT_END,
}
