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
//
// The same header parse also yields the page's doctitle, which nothing else in
// our pipeline captures (the golden HTML is a body fragment with no <h1>, and
// classifyContent does not parse titles). We collect it here -- keyed by the
// manifest resource id -- so emit-manifest can carry a `title` on each page and
// the converter has an authoritative source for MDX frontmatter.
function registerPageAliases (contentCatalog, siteAsciiDocConfig = {}) {
  let registered = 0
  const problems = []
  const titles = new Map()
  for (const page of contentCatalog.getPages((p) => p.out)) {
    let meta
    try {
      // headerOnly: we only need the header (page-aliases + doctitle).
      // attribute-missing:skip silences the missing-attribute warnings the
      // header parse would otherwise emit (this pass uses the site config, not
      // the per-version render config).
      const doc = loadAsciiDoc(page, contentCatalog, {
        ...siteAsciiDocConfig,
        headerOnly: true,
        attributes: { ...siteAsciiDocConfig.attributes, 'attribute-missing': 'skip' },
      })
      meta = extractAsciiDocMetadata(doc)
    } catch {
      continue
    }
    if (meta.doctitle) titles.set(resourceId(page.src), meta.doctitle)
    const value = meta.attributes['page-aliases']
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
  return { registered, problems, titles }
}

// The manifest resource id form (kept in sync with emit-manifest's buildManifest):
//   version@component:module:family$relative
function resourceId (src) {
  const { component, version, module: mod, family, relative } = src
  return `${version || ''}@${component}:${mod || ''}:${family}$${relative}`
}

module.exports = { registerPageAliases }
