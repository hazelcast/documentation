'use strict'

// The CENSUS instrumentation: replace every content attribute's value with a
// unique, inert token before rendering, so the rendered HTML records exactly
// where that attribute flowed.
//
// Why: rendering destroys the provenance we need to check. `{hazelcast-cloud}`
// renders to the word "Cloud", indistinguishable from an author typing "Cloud",
// so a checker reading only the render cannot tell a reference from a literal --
// which is why the first reference checker parsed the AsciiDoc source with
// regexes and could only ask a per-page yes/no question ("is this name mentioned
// anywhere in the output?"). Under poisoning the provenance survives: render with
// `hazelcast-cloud` set to `HZREF0042X` and every hit of that token in the HTML
// is, by construction, a place the source resolved that reference. Asciidoctor
// put it there -- includes expanded, tags sliced, ifdefs evaluated, nested
// `{description}` substituted -- so no source parsing is needed and the result is
// per-occurrence, not per-page. Nothing ever matches on the REAL value, so a page
// that merely happens to contain "5.7.0" (operator's CRD default table does) can
// never register as a reference.
//
// The census render is a THROWAWAY: its HTML is scanned for tokens and discarded.
// The golden that drives conversion and fidelity is the normal, unpoisoned render
// and is untouched by this module.
//
// Two properties keep the census trustworthy:
//   - SHAPE PRESERVING. Attribute substitution runs BEFORE the macro pass, so a
//     value that is a whole URL is what makes `{page-cloud-console}[text]` become
//     a link at all. A bare token there would render as plain text and move the
//     content we are trying to locate, so a URL value is poisoned to a URL
//     (`https://HZREF0042X.invalid/`) and a `www.` value to a `www.` host.
//   - REVERSIBLE. `unmask()` puts the real values back; the caller asserts the
//     unmasked census reproduces the golden, which is what proves poisoning
//     changed only the substituted text and nothing structural (see refcheck's
//     unmask guard). Values that HTML-escape on render are flagged
//     `unmaskSafe: false` and left out of that comparison rather than silently
//     mismatching.

const { isReserved } = require('../lib/reserved-attrs')

// Token shape: alphanumeric only, so no Asciidoctor substitution pass touches it
// and it survives URLs, slugs and code fences intact. Writer and matcher live
// together so they cannot drift.
// Case-INSENSITIVE matching: Asciidoctor slugs heading text into anchor ids, so a
// token in a heading also reaches `id="…-hzref0042x-…"` in lower case. Those
// occurrences are real and must be seen (they are recorded as derived-id bakes),
// so the matcher accepts either case and callers uppercase before lookup.
const tokenFor = (n) => `HZREF${String(n).padStart(4, '0')}X`
const TOKEN_RE = /HZREF\d{4}X/gi

// Why a value was left at its real value (recorded, so the census is auditable).
const SKIP_RESERVED = 'reserved' // machinery (lib/reserved-attrs.js)
const SKIP_FLAG = 'flag'         // boolean/null: a definedness switch, not text
const SKIP_EMPTY = 'empty'       // nothing renders, so nothing can be located

// Characters that render as HTML entities, so the real value cannot be textually
// substituted back into rendered HTML. None of the corpus's content values
// contains one today; the flag keeps that from becoming a silent guard failure.
const UNMASK_UNSAFE = /[&<>"]/

// Antora soft-set marker: `page-pagination: true@` means "unless overridden".
// It is stripped when Asciidoctor sets the attribute, so it must be preserved in
// the value we write but excluded from what we look for in the render.
const splitSoft = (raw) => (raw.endsWith('@') ? [raw.slice(0, -1), '@'] : [raw, ''])

// The poisoned stand-in for a real value: same lexical SHAPE, unique content.
function poisonedValueFor (raw, token) {
  const [value, soft] = splitSoft(raw)
  const slash = value.endsWith('/') ? '/' : ''
  const scheme = value.match(/^(https?:\/\/)/)
  if (scheme) return `${scheme[1]}${token}.invalid${slash}${soft}`
  if (/^www\./.test(value)) return `www.${token}.invalid${slash}${soft}`
  return token + soft
}

// Some attributes are RESOLUTION COORDINATES, not text: the corpus writes
// `xref:{page-latest-supported-mc}@management-center::index.adoc[…]`, so the value
// has to name a real component version or the xref does not resolve. Poisoning it
// breaks 1400+ xrefs and changes the render (Antora emits the raw target instead
// of a link), which the unmask guard catches -- correctly, but the whole
// attribute would then be uncheckable.
//
// Instead of excluding those attributes, resolve them OUT of target positions
// only: substitute the real value inside every `xref:`/`include::` target before
// poisoning, so the coordinate renders exactly as the golden does while every
// other occurrence of the same attribute stays poisoned and therefore checked.
// A coordinate occurrence produces no token and so no expectation, which is
// right: it becomes part of a URL, which the converter necessarily bakes.
//
// Only the TARGET is touched, never the `[label]` -- a label is flow text and
// must stay poisoned so its reference is still counted.
// `\s*` before the bracket: the corpus has `xref:…#diagnostics [Label]` with a
// stray space, which Asciidoctor still parses as a macro.
const TARGET_MACROS = [/(include::)([^[\s]+)(\s*\[)/g, /(xref:)([^[\s]+)(\s*\[)/g]
function preResolveTargets (text, lookup) {
  let out = text
  let resolved = 0
  for (const re of TARGET_MACROS) {
    out = out.replace(re, (whole, macro, target, open) => {
      const fixed = target.replace(/(\\?)\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g, (ref, esc, name) => {
        if (esc) return ref
        const v = lookup[name]
        if (v == null || v === '' || typeof v === 'boolean') return ref
        resolved++
        return String(v).replace(/@$/, '')
      })
      return macro + fixed + open
    })
  }
  return { text: out, resolved }
}

// Poison one component-version's attribute table IN PLACE (the in-memory catalog
// of a throwaway render). `nextToken` hands out globally unique token numbers, so
// a token identifies the (component, version, name) triple it came from -- the
// same name has different values, and therefore different tokens, per version.
//
// Returns { entries, skipped }: `entries` is the census key (what to look for in
// the render and what it stood in for), `skipped` the audit trail.
function poisonAttributes (attributes, nextToken) {
  const entries = []
  const skipped = []
  for (const [name, value] of Object.entries(attributes)) {
    if (isReserved(name)) { skipped.push({ name, reason: SKIP_RESERVED }); continue }
    if (value == null || typeof value === 'boolean') { skipped.push({ name, reason: SKIP_FLAG }); continue }
    const raw = String(value)
    const [bare] = splitSoft(raw)
    if (bare === '') { skipped.push({ name, reason: SKIP_EMPTY }); continue }
    const token = tokenFor(nextToken())
    const poisoned = poisonedValueFor(raw, token)
    attributes[name] = poisoned
    entries.push({
      name,
      token,
      value: bare,
      // What actually appears in the render (the soft-set marker never does).
      rendered: splitSoft(poisoned)[0],
      unmaskSafe: !UNMASK_UNSAFE.test(bare),
    })
  }
  return { entries, skipped }
}

// Poison every in-scope component version's table. A version without its own
// `asciidoc` config is handed the SITE config by reference -- home, privacy,
// tutorials and templates all are -- so poisoning in place would re-poison one
// shared table once per sharer, each pass recording the previous pass's token as
// the "real" value, and the unmask guard could then never recover the render.
// Each version gets its own table before any is touched.
// `components` is Antora-shaped: [{ name, versions: [{ version, asciidoc }] }].
function poisonComponentVersions (components, inScope, nextToken) {
  const entries = []
  const skipped = []
  const targets = []
  for (const comp of components) {
    if (!inScope(comp.name)) continue
    for (const v of comp.versions) {
      if (!v.asciidoc || !v.asciidoc.attributes) continue
      v.asciidoc = { ...v.asciidoc, attributes: { ...v.asciidoc.attributes } }
      targets.push([comp.name, v])
    }
  }
  for (const [component, v] of targets) {
    const r = poisonAttributes(v.asciidoc.attributes, nextToken)
    for (const e of r.entries) entries.push({ component, version: v.version, ...e })
    for (const s of r.skipped) skipped.push({ component, version: v.version, ...s })
  }
  return { entries, skipped }
}

// Put the real values back. Longest `rendered` first so no entry can be eaten by
// another's prefix. Only unmask-safe entries are substituted; the caller must
// exclude pages carrying an unsafe entry from the byte-equality guard.
function unmask (html, entries) {
  const safe = entries.filter((e) => e.unmaskSafe).sort((a, b) => b.rendered.length - a.rendered.length)
  let out = html
  for (const e of safe) out = out.split(e.rendered).join(e.value)
  return out
}

// Tokens still present after unmasking: a value that reached the render in a form
// we did not record (truncated, split, re-escaped). Never expected; surfaced
// rather than silently under-counted.
const residualTokens = (html) => [...new Set(html.match(TOKEN_RE) || [])]

module.exports = {
  poisonAttributes, poisonComponentVersions, poisonedValueFor, preResolveTargets, unmask, residualTokens, tokenFor, TOKEN_RE,
  SKIP_RESERVED, SKIP_FLAG, SKIP_EMPTY,
}
