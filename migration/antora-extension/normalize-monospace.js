'use strict'

// Source-text normalizer for inline monospace, applied to the in-memory catalog
// before the golden render (like mark-attributes/mark-conditionals). It wraps the
// content of constrained inline monospace spans that carry emphasis metacharacters
// (`_`, `*`) in a single-plus passthrough -- `` `X` `` -> `` `+X+` `` -- so
// Asciidoctor renders the span literally.
//
// WHY: AsciiDoc applies the "quotes" substitution INSIDE backtick monospace, so an
// `_`/`*` in a span can open an emphasis. Usually it bleeds to a DISTANT delimiter
// elsewhere on the page: e.g. `` `__trace` `` (a function literally named __trace)
// pairs its `__` with a later `__…__`, and `` `_` `` pairs with a following
// `_italic_`, so Antora emits `<code><em>trace</code>` / `<code><em></code>` and
// drops the characters the author wrote -- while ALSO corrupting the far span it
// stole the delimiter from. The source is correct; this is Asciidoctor's monospace-
// substitution behavior. The lost characters exist ONLY in the raw source text (by
// parse/AST time the `_`/`*` are gone), so the fix must be a pre-render source
// rewrite. A single-plus passthrough keeps the special-character substitution
// (so `<`/`&` still escape) while disabling quotes -- neutralizing the emphasis and
// freeing the distant delimiter, without touching anything else.
//
// IMPORTANT -- this is NOT a "mark-*" pass. The mark-* passes insert sentinels that
// readGolden() strips, so the instrumented golden is byte-identical to a bare
// render. This one deliberately CHANGES the rendered golden (that is the point:
// make it show `__trace`). Do not add a "strip" counterpart and do not expect
// byte-equality with a bare render.
//
// SAFE BY CONSTRUCTION: the passthrough is output-neutral wherever the emphasis was
// NOT firing -- `` `map_entry_set` `` -> `` `+map_entry_set+` `` -> identical
// `<code>map_entry_set</code>`. So components with no mis-parsed monospace (cloud,
// operator) render byte-identical after this runs; their fidelity is the guardrail
// that the rewrite never over-reaches.
//
// SCOPE / conservative skips (a missed span just keeps today's behavior, which is
// safe; a wrong rewrite is not, so we err toward skipping):
//   - only CONSTRAINED single-backtick spans (``double`` unconstrained is skipped);
//   - never inside verbatim delimited blocks (---- listing, .... literal,
//     ++++ passthrough), where backticks are literal;
//   - only spans whose content contains `_` or `*` (nothing else is at risk);
//   - skip content containing `+` (would break the passthrough), `{` (an attribute
//     reference -- passthrough would stop it expanding) or `\` (a deliberate escape
//     whose meaning passthrough would change).

// A verbatim (code/literal/passthrough) block delimiter: 4+ of - . or +, alone on
// the line. Backticks inside these are literal, so monospace rules do not apply.
// The `+` arm MUST require 4+ (`++++` passthrough) -- a lone `+` is an AsciiDoc
// list-continuation marker, and treating it as a block open swallows the rest of
// the page (this is why advanced-scripting slipped through the first cut).
const VERBATIM_DELIM = /^(-{4,}|\.{4,}|\+{4,})$/

// A constrained inline monospace span: an opening backtick at a left boundary
// (start of string or a char that is not word/backtick/backslash), non-backtick
// content, and a closing backtick not followed by a word char. Group 1 is the
// preserved boundary char; group 2 is the span content.
const MONO = /(^|[^\w`\\])`([^`\n]+)`(?!\w)/g

// Rewrite one source file's text. Returns it unchanged when nothing is eligible.
function literalizeMonospace (text) {
  if (!text.includes('`')) return text
  const lines = text.split('\n')
  let openDelim = null // the delimiter line that opened the current verbatim block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (openDelim != null) {
      if (trimmed === openDelim) openDelim = null // closing delimiter
      continue // inside a verbatim block: never touch
    }
    if (VERBATIM_DELIM.test(trimmed)) { openDelim = trimmed; continue }
    if (!line.includes('`')) continue
    lines[i] = line.replace(MONO, (m, boundary, content) => {
      if (!/[_*]/.test(content)) return m                    // nothing at risk
      if (/[+{\\]/.test(content)) return m                   // unsafe to wrap: skip
      return boundary + '`+' + content + '+`'
    })
  }
  return lines.join('\n')
}

module.exports = { literalizeMonospace, MONO, VERBATIM_DELIM }
