'use strict'

// MDX-safety primitives shared by the block and inline serializers.
//
// The converter's input is Asciidoctor HTML whose text nodes have already been
// entity-decoded by cheerio (`&#8217;` -> `'`, `&lt;` -> `<`). That text is
// dropped into two very different targets, each with its own hostile characters:
//
//   - Markdown prose: `*_`[]`# etc. can be read as formatting. Escaping them
//     with a backslash renders the literal character unchanged, so we escape
//     LIBERALLY -- it is always fidelity-safe (the rendered text is identical)
//     and never guesses whether a `*` was "meant" as emphasis.
//   - JSX text (inside raw-HTML we emit, e.g. table cells): `<` opens a tag and
//     `{` opens an expression, so both must become entities; `&` too.
//
// Nothing here changes what the reader sees; it only stops MDX from
// reinterpreting literal punctuation as markup.

// Characters Markdown/MDX may interpret in inline prose. Backslash first so we
// do not double-escape the escapes we add.
const MD_PROSE = /[\\`*_{}\[\]<>|#]/g

function mdEscape (s) {
  return s.replace(MD_PROSE, (c) => '\\' + c)
}

// Same as mdEscape but also escapes the pipe for GFM table cells (already in the
// set above) -- kept as a named helper so intent is explicit at call sites.
const mdEscapeCell = mdEscape

// JSX text: only the four characters that break JSX parsing / are ambiguous.
function jsxText (s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

// A JSX attribute value as a double-quoted string literal.
function jsxAttr (s) {
  return '"' + String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"'
}

// Inline code content is verbatim; pick a backtick fence longer than any run
// inside so the content is never split (CommonMark rule).
function inlineCode (text) {
  const longest = (text.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') || /^\s|\s$/.test(text) ? ' ' : ''
  return fence + pad + text + pad + fence
}

// A fenced code block whose backtick fence is longer than any run inside, so
// embedded triple-backticks cannot terminate it early.
function fencedCode (code, lang = '') {
  const longest = (code.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return fence + lang + '\n' + code + '\n' + fence
}

module.exports = { mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode }
