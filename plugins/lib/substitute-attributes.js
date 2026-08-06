'use strict'

// Replace Antora-style {attribute} placeholders with their resolved values,
// mirroring Asciidoctor `subs="attributes+"`. Unknown names are left literal
// (Antora leaves undefined attributes untouched too).
//
// A leading backslash escapes an attribute reference: `\{name}` renders as the
// literal `{name}` with the backslash removed and no substitution (Asciidoctor
// escaping — e.g. `member=\{0}` in the LDAP examples renders `member={0}`).
//
// Shared by BOTH the build-time example-attributes webpack loader (which
// produces the rendered code) AND the converter's example match-key builder
// (which must reproduce Antora's resolved golden to match it) — one
// implementation so the two cannot drift.
module.exports = function substitute (source, lookup) {
  return String(source).replace(/(\\?)\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g, (whole, esc, name) => {
    if (esc) return '{' + name + '}' // escaped ref -> literal, drop the backslash
    return Object.prototype.hasOwnProperty.call(lookup, name) ? String(lookup[name]) : whole
  })
}
