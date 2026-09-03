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
// This one header parse does three jobs:
//   1. registers page-aliases (so xrefs to renamed pages resolve);
//   2. collects each page's doctitle (keyed by manifest resource id) so
//      emit-manifest can carry a `title` and the converter has an authoritative
//      frontmatter source (the golden HTML is a body fragment with no <h1>);
//   3. primes `page.asciidoc` (doctitle/xreftext/navtitle) on EVERY page, so
//      that when another page's `xref:foo.adoc[]` (empty link text) renders, the
//      xref macro finds the target's xreftext instead of falling back to the raw
//      "foo.adoc" filename. Antora's site pipeline sets this during conversion;
//      our snapshot build converts page-by-page, so without this pre-pass a
//      target rendered later has no asciidoc metadata when an earlier page links
//      to it, and the golden shows unresolved link text.
// Page header attributes that become a page-level badge in the docs. Each maps
// to a frontmatter key (the `page-` prefix stripped) that the converter emits
// and the front-end `BADGES` registry keys off. Whitelisted rather than
// prefix-matched so an unrelated `page-*` attribute never leaks into a badge.
const BADGE_ATTRIBUTES = {
  'page-dedicated': 'dedicated',
  'page-enterprise': 'enterprise',
  'page-serverless': 'serverless',
  'page-beta': 'beta',
  'page-experimental-feature': 'experimental',
}

// Header attributes that feed the published `api/cloud.json` console index (the
// Hazelcast Cloud console's in-product help nav fetches this file). They are
// NOT page content and must not become MDX/frontmatter; a downstream generator
// (converter/convert.js) reads them from the manifest and reproduces cloud.json
// as a static build artifact, mirroring the production api-json.js extension.
// Only `cloud-tags` gates a page into the index; the rest refine its entries.
// Kept as raw strings (a `|` splits one page into multiple entries downstream).
const CLOUD_ATTRIBUTES = ['cloud-tags', 'cloud-title', 'cloud-order', 'cloud-url-video', 'cloud-anchor']

// Header attributes the tutorials LANDING PAGE renders each card from. Antora's
// landing page reads them off the content catalog at render time; nothing here
// keeps a catalog, so they are carried into the page's own frontmatter and read
// back by plugins/tutorials-index. A page is a card if it declares
// `page-layout: tutorial`, which is exactly the gate get-tutorial-pages.js
// applies in production. Values are kept RAW -- `page-categories` is a
// comma-list, `page-lang` too, and both are inconsistent across the 57 guides;
// normalising them here would be a content change, not a migration.
const TUTORIAL_ATTRIBUTES = ['page-est-time', 'page-product', 'page-lang', 'page-categories', 'page-enterprise', 'description']

function registerPageAliases (contentCatalog, siteAsciiDocConfig = {}) {
  let registered = 0
  const problems = []
  const titles = new Map()
  // resource id -> array of badge frontmatter keys set on that page.
  const badges = new Map()
  // resource id -> raw cloud-* attribute strings, for pages that carry
  // `cloud-tags` (the api/cloud.json console index). See CLOUD_ATTRIBUTES.
  const cloudMeta = new Map()
  // resource id -> raw card attributes, for pages declaring page-layout: tutorial.
  const tutorialMeta = new Map()
  // The header must be parsed with the page's OWN component-version asciidoc
  // config, the one classifyContent resolved from that component's antora.yml —
  // not the site config. A doctitle may reference a component attribute
  // (`= Management Center {full-version}`), and under the site config that name is
  // simply undefined, so the brace survives into every consumer: the manifest
  // `title` (hence frontmatter `title:` and the nav labels derived from it) and
  // `page.asciidoc.xreftext`, which is what an empty-text `xref:foo.adoc[]`
  // renders as its LINK TEXT in the golden. Antora's own pipeline converts with
  // the per-version config, so a site-config header parse makes the golden
  // unfaithful: MC's cluster-license linked to "Manage {enterprise-product-name}
  // license keys" on all 10 versions where the live site reads "Enterprise
  // Edition". Falls back to the site config for a page whose component version
  // carries none.
  const configFor = (page) => {
    const cv = contentCatalog.getComponentVersion(page.src.component, page.src.version)
    return (cv && cv.asciidoc) || siteAsciiDocConfig
  }
  for (const page of contentCatalog.getPages((p) => p.out)) {
    let meta
    try {
      // headerOnly: we only need the header (page-aliases + doctitle).
      // attribute-missing:skip silences the missing-attribute warnings the
      // header parse would otherwise emit for genuinely undefined names.
      const config = configFor(page)
      const doc = loadAsciiDoc(page, contentCatalog, {
        ...config,
        headerOnly: true,
        attributes: { ...config.attributes, 'attribute-missing': 'skip' },
      })
      meta = extractAsciiDocMetadata(doc)
    } catch {
      continue
    }
    if (meta.doctitle) titles.set(resourceId(page.src), meta.doctitle)
    // Collect any page-level badge attributes set on this page. Mirrors the UI
    // gate EXACTLY -- article.hbs renders the page-level class from
    // `{{#if (eq @root.page.attributes.enterprise 'true')}}`, a strict compare,
    // so an attribute set to the EMPTY string is not a badge. The product repos
    // only ever write `true`/`false` and so cannot tell the two apart, but the
    // guide repos write `:page-enterprise:` with no value on 11 tutorials, where
    // "set, therefore badged" is wrong. NB the tutorials LANDING page uses a
    // different gate (plain Handlebars truthiness, so its cards treat the string
    // "false" as enterprise); that is card data, not a page badge.
    const pageBadges = []
    for (const [attr, key] of Object.entries(BADGE_ATTRIBUTES)) {
      if (meta.attributes[attr] === 'true') pageBadges.push(key)
    }
    if (pageBadges.length) badges.set(resourceId(page.src), pageBadges)
    // Capture the cloud-* console-index attributes on any page that opts in via
    // `cloud-tags` (site-wide: a tutorials page can appear in the index too).
    if (meta.attributes['cloud-tags'] != null) {
      const cm = {}
      for (const attr of CLOUD_ATTRIBUTES) {
        const v = meta.attributes[attr]
        if (v != null) cm[attr] = v
      }
      cloudMeta.set(resourceId(page.src), cm)
    }
    // Capture the card attributes of any page that declares itself a tutorial.
    if (meta.attributes['page-layout'] === 'tutorial') {
      const tm = {}
      for (const attr of TUTORIAL_ATTRIBUTES) {
        const v = meta.attributes[attr]
        if (v != null) tm[attr] = v
      }
      tutorialMeta.set(resourceId(page.src), tm)
    }
    // Prime the page's asciidoc metadata so xref link-text resolves to this
    // page's xreftext when another page links to it (see the note above).
    if (!page.asciidoc) page.asciidoc = meta
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
  return { registered, problems, titles, badges, cloudMeta, tutorialMeta }
}

// The manifest resource id form (kept in sync with emit-manifest's buildManifest):
//   version@component:module:family$relative
function resourceId (src) {
  const { component, version, module: mod, family, relative } = src
  return `${version || ''}@${component}:${mod || ''}:${family}$${relative}`
}

module.exports = { registerPageAliases }
