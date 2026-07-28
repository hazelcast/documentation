'use strict'

const { loadAsciiDoc, extractAsciiDocMetadata } = require('@antora/asciidoc-loader')

// Antora's SITE GENERATOR registers each page's `page-aliases` header attribute
// as an alias resource in the content catalog; that registration is what lets an
// xref to a renamed/moved page resolve (resolvePage falls back to the alias
// family). classifyContent and loadAsciiDoc do NOT do this on their own, so any
// pipeline that skips the site generator -- our index pass and snapshot builder
// -- must register aliases itself, or xrefs to renamed pages silently fail to
// resolve and render broken (making the golden snapshot unfaithful and the
// manifest incomplete). Call this AFTER classifyContent and BEFORE converting.
//
// Only the page header is parsed (headerOnly), so this is cheap relative to a
// full convert and needs no xref resolution of its own.
function registerPageAliases (contentCatalog, siteAsciiDocConfig = {}) {
  let registered = 0
  const problems = []
  for (const page of contentCatalog.getPages((p) => p.out)) {
    let value
    try {
      // headerOnly: we only need the page-aliases value. attribute-missing:skip
      // silences the missing-attribute warnings the header parse would otherwise
      // emit (this pass uses the site config, not the per-version render config).
      const doc = loadAsciiDoc(page, contentCatalog, {
        ...siteAsciiDocConfig,
        headerOnly: true,
        attributes: { ...siteAsciiDocConfig.attributes, 'attribute-missing': 'skip' },
      })
      value = extractAsciiDocMetadata(doc).attributes['page-aliases']
    } catch {
      continue
    }
    if (!value) continue
    for (const spec of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      // Antora throws on invalid/duplicate/self aliases; it logs and continues,
      // so we collect rather than abort.
      try {
        contentCatalog.registerPageAlias(spec, page)
        registered++
      } catch (err) {
        problems.push(err.message)
      }
    }
  }
  return { registered, problems }
}

module.exports = { registerPageAliases }
