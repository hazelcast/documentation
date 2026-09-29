'use strict'

// Replaces {attribute} placeholders (Asciidoctor `attributes+`); unknown names stay literal.
// `\{name}` is an escape: it renders a literal `{name}` with the backslash dropped.
// Shared by the example-attributes loader and the converter's match-key builder so they cannot drift.
module.exports = function substitute (source, lookup) {
  return String(source).replace(/(\\?)\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g, (whole, esc, name) => {
    if (esc) return '{' + name + '}' // escaped ref -> literal, drop the backslash
    return Object.prototype.hasOwnProperty.call(lookup, name) ? String(lookup[name]) : whole
  })
}
