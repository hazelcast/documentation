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

// Fold the typographic glyphs Asciidoctor substitutes for straight ASCII (curly
// single/double quotes, non-breaking space) back to ASCII in PROSE only. This
// is fidelity-safe -- Layer-1 `normalizeProse` already folds the same glyphs,
// so the rendered text compares equal -- and is never applied to code
// (inlineCode/fencedCode), where a character could be significant. En/em dashes
// and ellipsis are intentional typography and deliberately left alone.
function foldTypographic (s) {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/ /g, ' ')
}

function mdEscape (s) {
  return foldTypographic(s).replace(MD_PROSE, (c) => '\\' + c)
}

// Same as mdEscape but also escapes the pipe for GFM table cells (already in the
// set above) -- kept as a named helper so intent is explicit at call sites.
const mdEscapeCell = mdEscape

// JSX text: only the four characters that break JSX parsing / are ambiguous.
function jsxText (s) {
  return foldTypographic(s)
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
// --- URLs in prose ----------------------------------------------------------
// Two different problems, both about a URL that is NOT a link in the golden.
//
// (1) GFM AUTOLINK LITERALS. Markdown turns a bare `https://…` in prose into a
// link; Asciidoctor did not (the author escaped it `\https://`, or a preceding
// character blocked Asciidoctor's autolink rule). So faithfully copying the text
// ADDS a link, which Layer 2 catches as `links: golden=N converted=N+1`.
//
// Escaping does NOT fix this, despite being the obvious move: `https\://` works
// only when the host has no dot. Measured through this site's own pipeline
// (@mdx-js/mdx + remark-gfm): `http\://127.0.0.1:8080/a`, `http\://example.com/a`,
// `http&#58;//…` and `www\.example.com` ALL still autolink, because micromark
// recognises the URL across the escape. What does work is splitting the text run
// with an empty MDX expression immediately after the scheme's colon --
// `https:{/**/}//github.com/x` -- which renders the identical characters, cannot
// swallow a neighbouring <Variable/> (unlike wrapping the URL in a JSX string),
// and leaves real Markdown links untouched. Verified in a paragraph, a list item,
// a table cell, and between smart quotes.
const SCHEME = /\b(https?:)(?=\/\/[^\s<]*[A-Za-z0-9])/g
const breakAutolinks = (s) => s.replace(SCHEME, '$1{/**/}')

// (2) PLACEHOLDER URLS. An address the reader types or opens on their own
// machine is never a navigable destination, so it should read as code, never as a
// link. The corpus authors this five different ways (backtick + `\` escape,
// backtick alone, bare + escape, bare, smart-quoted), which renders three
// different ways -- so the converter normalises it: inline code, no link.
//
// The hosts are exactly the ones that CANNOT resolve for a reader: loopback,
// the mDNS `.local` suffix (RFC 6762) and the reserved example domains
// (RFC 2606). This is the same judgement the harness already records for an
// angle-bracket pseudo-URL (`http://<mc-ip-address>:8080`, where the converter
// drops the un-followable anchor and keeps the code) extended from "cannot be a
// valid URL" to "is not a real destination".
const PLACEHOLDER_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[\w-]+\.local|example\.(?:com|org|net))(?::\d+)?(?:[/?#]|$)/i
const isPlaceholderUrl = (url) => PLACEHOLDER_URL.test(url)

// A URL inside a run of prose. The character class is RFC 3986's, listed
// positively rather than as "not whitespace": a negative class swallowed the
// closing typographic quote of Antora's `“http://127.0.0.1:8080/oidc/auth”` into
// the code span, which also stopped foldTypographic seeing it. The last
// character may not be sentence punctuation, so "…at https://localhost:443."
// keeps its full stop outside the span.
const URL_CHAR = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%"
const URL_END = "A-Za-z0-9\\-_~/#@$&+=%"
const PROSE_URL = new RegExp(`https?://[${URL_CHAR}]*[${URL_END}]`, 'g')

function inlineCode (text) {
  // Newlines are collapsed FIRST, for two reasons that point the same way. A
  // Markdown code span cannot hold a line break at all -- CommonMark converts one
  // to a space -- so collapsing changes nothing about the render. And a newline at
  // an EDGE of the content defeats the pad below: the pad would sit immediately
  // before that newline, where inline()'s `[ \t]+\n` end-of-line cleanup deletes
  // it, and the whitespace separating this span from the preceding text vanishes
  // with it. That is not hypothetical -- Asciidoctor's repair of its own malformed
  // overlapping markup on serialization/schema-evolution-full (an upstream
  // `` `NULL`s `` breaks its backtick pairing, so a <code> opens inside <strong>
  // and closes after it) leaves a soft line break at the START of a <code>, and
  // `normally.` ran straight into `COUNT(currency)`. Collapsing keeps the span on
  // one line, where no line-based cleanup can reach the pad.
  const flat = text.replace(/\s*\n\s*/g, ' ')
  const longest = (flat.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') || /^\s|\s$/.test(flat) ? ' ' : ''
  return fence + pad + flat + pad + fence
}

// A fenced code block whose backtick fence is longer than any run inside, so
// embedded triple-backticks cannot terminate it early.
function fencedCode (code, lang = '') {
  const longest = (code.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return fence + lang + '\n' + code + '\n' + fence
}

module.exports = {
  breakAutolinks, isPlaceholderUrl, PROSE_URL, mdEscape, mdEscapeCell, jsxText, jsxAttr, inlineCode, fencedCode }
