'use strict'

// Shared layout/source config for the migration tooling: which source repo +
// branch a component's pages come from, which versions are emitted, and where
// (and under what slug) each converted page lands. Single-sourced here so the
// converter (converter/convert.js) and the reference checker (refcheck/run.js)
// resolve sources and output paths identically -- they must never drift.

const path = require('node:path')

// The DEFAULT version segment the current (main/-snapshot) branch is published
// under. Antora serves operator's main at `/operator/latest-snapshot/…`, so that
// is also the golden/manifest version key AND the Docusaurus current-version
// `path`. A component whose main is NOT a distinct `-snapshot` line overrides
// this per-component (see VERSIONS[*].current and currentSegFor): clc's main
// declares itself version 5.5.1, so clc has no `latest-snapshot` render and its
// current seg is `5.5.1`.
const CURRENT_SEG = 'latest-snapshot'

// Component -> source repo mirror (under .sources/), the nav.adoc path, and how
// to pick the branch for a version segment. A versioned component reads a
// different branch per segment (`refFor`); an unversioned one has a plain `ref`.
const NAV_SOURCES = {
  cloud: { repo: 'cloud-docs.git', ref: 'main', file: 'docs/modules/ROOT/nav.adoc' },
  operator: {
    repo: 'hazelcast-platform-operator-docs.git',
    file: 'docs/modules/ROOT/nav.adoc',
    refFor: (seg) => (seg === CURRENT_SEG ? 'main' : `v/${seg}`),
  },
  // clc has no separate `-snapshot` line: its main declares version 5.5.1 and the
  // index-playbook sources it as `branches: [v/*]` only, so EVERY seg (current
  // 5.5.1 included) reads its `v/<seg>` tag branch.
  clc: {
    repo: 'clc-docs.git',
    file: 'docs/modules/ROOT/nav.adoc',
    refFor: (seg) => `v/${seg}`,
  },
  // Platform (Antora component name `hazelcast`, hence the URL /hazelcast/... and
  // the reason the plugin id is `hazelcast` while the navbar says "Platform").
  // Its main is a NUMBERED snapshot like management-center's -- it declares
  // version `6.0-snapshot`, display `6.0-SNAPSHOT` -- so its current seg is that
  // number (VERSIONS.current) and main is the branch behind it. Multi-module and
  // by far the largest component: 439 pages over 46 modules at 5.7.
  hazelcast: {
    repo: 'hz-docs.git',
    file: 'docs/modules/ROOT/nav.adoc',
    refFor: (seg) => (seg === currentSegFor('hazelcast') ? 'main' : `v/${seg}`),
  },
  // management-center's main IS a snapshot line, but a NUMBERED one: it declares
  // version `5.12-snapshot` (display `5.12-SNAPSHOT`), not operator's undated
  // `latest-snapshot`. So its current seg is that number (VERSIONS.current) and
  // main is the branch behind it — read via currentSegFor rather than repeated
  // here, so the seg is written down exactly once. nav.adoc lives in ROOT even
  // though the pages are spread over 11 modules: MC is the first MULTI-MODULE
  // component migrated (its module name is a URL segment, e.g. /clusters/…).
  'management-center': {
    repo: 'management-center-docs.git',
    file: 'docs/modules/ROOT/nav.adoc',
    refFor: (seg) => (seg === currentSegFor('management-center') ? 'main' : `v/${seg}`),
  },
}

// Live version set per versioned component: the current (main) branch plus the
// released versions cut into `<component>_versioned_docs`. Newest release first.
// Phase 1 warms up on operator with just the newest release; scale by extending
// `releases` — the site takes the live set from the `<component>_versions.json`
// written from here, so nothing in docusaurus.config.ts has to follow. Older
// releases are frozen as static HTML outside this build (freeze plan), so they
// are deliberately absent here.
// `current` (optional) overrides the current-version golden/manifest seg when a
// component's main is not a distinct `-snapshot` line; it defaults to
// CURRENT_SEG (see currentSegFor). clc's main == the released 5.5.1, so its
// current seg is `5.5.1` and only the older 5.5.0 is cut as a versioned copy —
// matching the two versions clc serves in production.
// MC's main declares `5.12-snapshot`, so unlike operator its current seg is a
// NUMBER, and unlike clc that number is an unreleased snapshot — the dropdown
// still lands on the newest release (5.11). The three releases below are the live
// set; 5.8 and older are frozen (freeze plan), which is why they stop at 5.9.
const VERSIONS = {
  operator: { releases: ['5.20', '5.19', '5.18', '5.17', '5.16', '5.15', '5.14', '5.13', '5.12'] },
  clc: { current: '5.5.1', releases: ['5.5.0'] },
  'management-center': { current: '5.12-snapshot', releases: ['5.11', '5.10', '5.9'] },
  // Platform's main declares `6.0-snapshot` (an unreleased snapshot, as MC's is),
  // so its current seg is a NUMBER and the dropdown lands on the newest release
  // ('latest-release' in docusaurus.config.ts). Phase 1 converted the current
  // branch alone so the plugin was stood up and the whole 439-page corpus
  // converted once before the release copies multiplied it; phase 2 adds the
  // releases.
  //
  // The live set is 5.7 down to 5.3; 5.2 and older are frozen (freeze plan).
  //
  // 5.4 and 5.3 use a DIFFERENT nav architecture from 5.5-and-newer, and adding
  // them is what forced the converter to handle it. Their ROOT/nav.adoc is a
  // skeleton that pulls in per-module `include::<module>:partial$nav.adoc[]`
  // files (27 live includes at 5.3, 22 at 5.4), where 5.5+ are flat single files.
  // converter/lib/nav resolveNavIncludes now splices those in before parsing, as
  // Antora does; without it those versions lost most of their sidebar tree (235
  // of 398 pages at 5.4, 333 of 390 at 5.3 landed at the component root as
  // `unlisted`). It is a no-op on a flat nav, so 5.5+ are unchanged byte for byte.
  //
  // The same two versions also made the `maintain-cluster/rest-api` nav injection
  // conditional: that page is an orphan from 5.5 up, but ALREADY in nav at 5.4 and
  // 5.3, and its `nav.after` anchor (rest-api-swagger) is a page that did not
  // exist before 5.5. injectNavEntries now skips an injection whose page is
  // already listed, rather than throwing over a version that needs no fix.
  hazelcast: { current: '6.0-snapshot', releases: ['5.7', '5.6', '5.5', '5.4', '5.3'] },
}

// Attributes whose references are MARKED in the golden (antora-extension/
// mark-attributes.js) and turned back into <Variable> by the converter, per
// component. Use this — rather than the value-based reverse-map — for attributes
// whose resolved value is an ambiguous word that cannot be safely told apart
// from a literal in rendered HTML (e.g. hazelcast-cloud -> "Cloud", where the
// page also says "Confluent Cloud"). The marker gives the exact positions, so
// only genuine references are variableised. Values are single-sourced into
// variables.ts exactly like the SINGLE_SOURCE set.
const MARKED_ATTRS = {
  cloud: ['hazelcast-cloud'],
  // operator's page-latest-supported-hazelcast is a version number that COLLIDES
  // with literal data on the very page that references it: scaling-upgrading
  // carries an Operator->Hazelcast compatibility matrix of historical versions,
  // and at 5.12 its value (5.4.0) is also the Hazelcast cell of rows 5.11 and
  // 5.12, at 5.14 (5.5.2) the cell of row 5.14, and at 5.13 the value is the
  // bare `5.5`, which is the OPERATOR column's cell for row 5.5. Page-scoping
  // the reverse-map cannot help — the collision is on a page that genuinely
  // references the attribute — so those cells were variableised and would have
  // followed the attribute on a version bump, silently rewriting historical
  // facts. Marking gives the exact reference positions instead. Marked attrs are
  // excluded from the PROSE reverse-map only (see proseVarsFor in convert.js).
  //
  // It stays in SINGLE_SOURCE as well, because marking alone does NOT carry its
  // reference inside image-registry's yaml block. Note the reason is not that
  // marking skips the block -- that file uses BACKTICK fences, which are absent
  // from mark-attributes' DELIMITERS set, so the pass does mark inside it and the
  // golden really does contain `version: <span class="hz-attr-…">5.7.0</span>`
  // within <code>. But a marker span does not survive the converter's fence path
  // as a reference (a fence's content becomes text), so the CODE value map is what
  // restores it. Verified by experiment: dropping the attr from SINGLE_SOURCE
  // bakes it on 4 image-registry pages (refcheck `expected 1, found 0`).
  operator: ['page-latest-supported-hazelcast'],
  // clc references {hazelcast-cloud} heavily; its value "Cloud" is the same
  // ambiguous prose word as in cloud (a page also says "Confluent Cloud"), so it
  // must be MARKED, not value-reverse-mapped.
  clc: ['hazelcast-cloud', 'full-version'],
  // The tutorials that run on Cloud say {hazelcast-cloud} in prose: the same
  // ambiguous "Cloud" as above.
  tutorials: ['hazelcast-cloud'],
  // Platform marks two classes of attribute, both cases where a value reverse-map
  // structurally cannot decide:
  //
  //   1. The value is ALSO written as a literal on a page that references the
  //      attribute. `getting-started/editions` is the clear case: it says
  //      "you can't turn a Community Edition into an Enterprise Edition by adding
  //      a license key" in prose while also referencing both attributes, so a
  //      value match would variableise the literal and rewrite that sentence on a
  //      product rename. Same for {ucn}/{ucd}: "User Code Namespaces" appears as a
  //      literal 9 times and "User Code Deployment" 23 times outside the
  //      attribute. {hazelcast-cloud} is the usual "Cloud" ambiguity. And
  //      {minimum-java-version} resolves to the BARE NUMBER `17`, which no
  //      boundary rule can tell from any other 17 in prose.
  //
  //   2. SEVERAL ATTRIBUTES SHARE ONE VALUE, so value->name is not a function.
  //      {os-version}, {ee-version} and {full-version} are all `5.8.0-SNAPSHOT`
  //      (14 pages reference two of the three), and the C++, C# and Python client
  //      versions are all `5.7.0` (2 pages reference two or more). Marking gives
  //      the position, so the right NAME survives; without it the converter emits
  //      whichever name won the map and refcheck reports the pair as one baked +
  //      one over-variableised reference.
  //
  // Several of these are in SINGLE_SOURCE_ATTRS as well, for the same reason
  // operator's page-latest-supported-hazelcast is: marking does not carry a
  // reference through a CODE FENCE, so the value map is what restores those
  // occurrences (e.g. {minimum-java-version} inside `<maven.compiler.release>`,
  // {ee-version} inside a docker `hazelcast/hazelcast-enterprise:{ee-version}`
  // command). Keeping both is not double-substitution: a marked occurrence becomes
  // a <Variable> from its span, leaving no literal for the reverse-map to find.
  hazelcast: [
    'enterprise-product-name', 'open-source-product-name', 'hazelcast-cloud',
    'ucn', 'ucd', 'minimum-java-version', 'minimum-maven-version',
    'os-version', 'ee-version', 'full-version',
    'page-latest-supported-cplusplus-client',
    'page-latest-supported-csharp-client',
    'page-latest-supported-python-client',
    // The rest of the compatibility table's curated numbers, for the same reason
    // and on the evidence of the versions we emit: at 5.6 {page-latest-supported-
    // clc} is `5.5.0`, the same as {page-latest-supported-csharp-client}; at 5.7
    // {page-latest-supported-nodejs-client} is `5.6.0`, the same as the csharp AND
    // python numbers. deploy/versioning-compatibility references all of them in
    // one table, so the value was dropped as ambiguous and the marked sibling won
    // -- the unmarked one baked. Which members of the family collide is an
    // accident of each release's numbers, so the two proven cases are marked here
    // and the gate stays the guard on the next one ({page-latest-supported-po} and
    // -mc-installer are both `latest-snapshot` at 5.7 and main, and escape only
    // because no page references both).
    'page-latest-supported-clc',
    'page-latest-supported-nodejs-client',
    // 3. The whole-token boundary REFUSES the value where the source put it, so a
    //    value match structurally cannot find it and marking is the only route:
    //      {java-client} = "Java Client and Embedded Server", written at the end of
    //        a sentence, so the `(?![\w.-])` lookahead rejects the following full
    //        stop. That guard has to stay -- it is what stops `5.6.0` matching
    //        inside `0.3.5.6.0` -- and it was written for version numbers, where a
    //        trailing `.` really is ambiguous; for a prose phrase it never is.
    //      {version} = "5.8-SNAPSHOT", glued into a longer token
    //        (`hazelcast-config-{version}.xsd`) -- the same case as clc's
    //        full-version inside `hazelcast-clc-setup-v{full-version}.exe`.
    //      {page-latest-supported-mc} = "5.12-snapshot", again sentence-final
    //        ("versions of Management Center before {page-latest-supported-mc}.").
    'java-client', 'version', 'page-latest-supported-mc',
  ],
}

// NOTE on `clc: full-version` — it is in BOTH this list and
// SINGLE_SOURCE_ATTRS, deliberately, because the two mechanisms cover different
// contexts. It is referenced inside INLINE code (`hazelcast-clc-setup-v{full-
// version}.exe`), where the value reverse-map structurally cannot reach it: the
// whole-token boundary `(?<![\w.-])…(?![\w.-])` refuses a version glued into a
// longer token, and that guard has to stay (it is what stops `5.6.0` matching
// inside `0.3.5.6.0`). Marking gives the position instead, so no boundary
// matching is needed. It stays in SINGLE_SOURCE because marking skips verbatim
// blocks, so its 20 occurrences inside CODE FENCES still depend on the
// reverse-map + `vars` flag. Keeping both is not double-substitution: a marked
// occurrence becomes a <Variable> from its span, leaving no literal for the
// reverse-map to find.

// The marked-attribute names for a component (empty array if none).
const markedAttrsFor = (component) => MARKED_ATTRS[component] || []

// A component is "versioned" (values nested per version) exactly when it appears
// in VERSIONS; otherwise its single value is global. Mirrors versionsToProcess.
const isVersioned = (component) => Object.prototype.hasOwnProperty.call(VERSIONS, component)

// The golden/manifest seg that maps to the Docusaurus CURRENT version for a
// component: VERSIONS[c].current when set, else the default CURRENT_SEG. This is
// the single source of truth for "which seg is current" -- convert.js keys the
// version NAME off it, so it must never be recomputed elsewhere.
const currentSegFor = (component) =>
  (VERSIONS[component] && VERSIONS[component].current) || CURRENT_SEG

// Components we only ever READ from. NAV_SOURCES doubles as the MIGRATED set --
// every gate iterates its keys and the converter emits a tree per entry -- so a
// component that has no nav, no pages of its own here, and must never appear in a
// gate's component list cannot live there. `templates` (hazelcast-code-samples) is
// exactly that: operator's tutorial pages include its example$ files, so the
// resolver has to be able to open them, but it publishes nothing. Unversioned, so
// a plain `ref`; `modulesRoot` is explicit because there is no nav.adoc to derive
// it from.
//
// NOTE `templates` is a MERGED component: hazelcast-docs/templates and
// hazelcast-code-samples/docs both declare `name: templates`, and Antora unions
// them. Only the code-samples half is modelled here, because that is the half
// anything RESOLVES into -- all 290 references to the component are
// `example$` includes from operator's tutorial pages, and every one lands in
// code-samples. The hazelcast-docs half is reached only through `{templates-url}`
// includes in the guide repos, which the converter takes from the golden rather
// than resolving here. If a `page$`/`partial$` reference into that half ever needs
// resolving, this entry has to become a LIST of mirrors tried in order -- today it
// would simply find nothing, which is the same answer it gave before code-samples
// was pinned at all.
const READ_ONLY_SOURCES = {
  templates: { repo: 'hazelcast-code-samples.git', ref: 'master', modulesRoot: 'docs/modules' },
}

// Where a component's SOURCE FILES are read from -- the migrated set plus the
// read-only ones. Use this (not NAV_SOURCES) whenever the question is "can I open
// this component's files", and NAV_SOURCES when the question is "is this component
// one we publish".
const sourceMirrorFor = (component) => NAV_SOURCES[component] || READ_ONLY_SOURCES[component] || null

// The branch (git ref) a component's source is read from for a version segment.
const refFor = (component, seg) => {
  const src = sourceMirrorFor(component)
  if (!src) return null
  return src.refFor ? src.refFor(seg) : src.ref
}

// The versions to emit for a component, in processing order. Unversioned
// components yield a single pass with `seg === null`. Versioned ones yield the
// current (main) branch first, then each live release. `kind` drives where the
// tree lands and whether it is the plugin's current or a versioned copy.
function versionsToProcess (component, releasesOverride) {
  const cfg = VERSIONS[component]
  if (!cfg) return [{ seg: null, kind: 'unversioned' }]
  const releases = releasesOverride || cfg.releases
  return [
    { seg: currentSegFor(component), kind: 'current' },
    ...releases.map((seg) => ({ seg, kind: 'release' })),
  ]
}

// Where a (component, version) tree is written.
//   unversioned / current -> ../<component>                       (plugin path)
//   release X             -> ../<component>_versioned_docs/version-X
function outDirFor (outRoot, component, { seg, kind }) {
  if (kind === 'release') return path.join(outRoot, `${component}_versioned_docs`, `version-${seg}`)
  return path.join(outRoot, component)
}

// A page's site URL -> the `slug` it must carry to preserve that URL. The slug
// is relative to the plugin instance's version base (routeBasePath + version
// path), so we strip the `/<component>[/<seg>]` prefix and keep the remainder
// verbatim — which preserves module segments (operator's `tutorials/` pages)
// that a stem-only slug would drop. A version root (`/operator/5.18/`) -> `/`.
function urlToSlug (url, component, seg) {
  const prefix = '/' + component + (seg ? '/' + seg : '')
  let s = url.startsWith(prefix) ? url.slice(prefix.length) : url
  if (s.length > 1) s = s.replace(/\/$/, '') // drop trailing slash (trailingSlash:false), except root
  if (s === '' || s === '/') return '/'
  return s.startsWith('/') ? s : '/' + s
}

// Components with no Antora nav at all. Their pages are reached from an index
// page rather than a sidebar, so "absent from nav" is the normal state, not an
// orphan -- and production serves AND sitemaps every one of them (all 58
// tutorials are in sitemap-tutorials.xml), so they must not be emitted
// `unlisted`, which would drop them from the sidebar, search and sitemap alike.
const NAVLESS = new Set(['tutorials'])

// URLs served by a hand-written React page in src/pages rather than by converted
// content -- the same arrangement /privacy already has (src/pages/privacy.tsx).
// The converter must not emit an .mdx for these: a doc claiming the route would
// win over the site page. The tutorials landing page is a filterable card index
// that Antora builds from its content catalog at render time; there is no
// catalog here, so it is rebuilt as a component reading the card frontmatter the
// converter writes onto each tutorial (see plugins/tutorials-index).
//
// `/home/` is the site landing page, and the clearest case of the pair: its
// Antora source (home/modules/ROOT/pages/index.adoc) is four lines of attributes
// with NO body -- every card lives in the UI template, so the golden HTML for it
// is literally one byte. There is no content to convert and nothing to compare,
// and the replacement (src/pages/index.tsx) is a deliberate redesign besides.
// The key is the Antora URL, which is what fidelity joins on; the page itself is
// served at `/`, with `/home` redirecting in (docusaurus.config.ts).
const SITE_PAGES = new Set(['/tutorials/', '/home/'])

const isSitePage = (url) => SITE_PAGES.has(url)

const isNavless = (component) => NAVLESS.has(component)

module.exports = {
  CURRENT_SEG,
  NAV_SOURCES,
  READ_ONLY_SOURCES,
  sourceMirrorFor,
  NAVLESS,
  SITE_PAGES,
  VERSIONS,
  MARKED_ATTRS,
  markedAttrsFor,
  isNavless,
  isSitePage,
  isVersioned,
  currentSegFor,
  refFor,
  versionsToProcess,
  outDirFor,
  urlToSlug,
}
