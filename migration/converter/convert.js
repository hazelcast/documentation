'use strict'

// Converter CLI: turn golden HTML fragments into Docusaurus MDX pages, laid out
// per the component's Antora nav.adoc.
//
//   node converter/convert.js --component cloud [--out ../cloud]
//                             [--id /cloud/cluster-side-modules] [--dry] [--verbose]
//   node converter/convert.js --component operator [--releases 5.18,5.17]
//
// Input  : build/golden/pages/<component>/[<version>/]**.html (the faithful
//          Antora render) + build/manifest/manifest.json (titles + inventory)
//          + the component's nav.adoc (from the frozen source mirror, per branch)
// Output : one Docusaurus docs tree PER VERSION, each **.mdx laid out to mirror
//          the nav tree, each page carrying a `slug` that preserves its exact
//          Antora URL, plus `sidebar_label` / `sidebar_position`; and a
//          `_category_.json` per category folder.
//
// Versioned components (operator, and later platform/MC) emit the current
// (main/-snapshot) branch as the plugin's editable CURRENT version and each
// released `v/X` branch into `<component>_versioned_docs/version-X`, alongside
// the `<component>_versions.json` release list Docusaurus needs (the site's
// src/docsPlugins.ts derives everything else per-version from that one file, the
// per-release sidebar stubs included). Unversioned components (cloud) emit a
// single tree at
// `../<component>` exactly as before.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { goldenPages } = require('../fidelity/lib/pairing')
const { convertBody } = require('./lib/html-to-mdx')
const { collectOccurrences, decide, consumerAttrs } = require('./lib/partials')
// Link targets written with an `{attribute}` in them — the exact-match href path
// (see buildTemplates); shared with the selftest so the grammar has one definition.
const { attrHrefTemplates, resolveHref } = require('./lib/links')
// The verbatim-block counterpart: the source's own code LINES carrying an
// `{attribute}`, so a fence keeps the right NAME where several attributes share
// one value (hazelcast's os-/ee-/full-version are all `5.8.0-SNAPSHOT`).
const { attrCodeTemplates, buildCodeTemplates, resolveTemplates } = require('./lib/code-templates')
// The source-side include walker, shared with refcheck so the converter and the
// gate agree on which files a page reaches. Needed here because a partial's code
// lines have to be templated against the page that includes them: get-started-cli
// pulls its brew/apt/yum commands from install-hazelcast, and those name
// {os-version} where the page itself names {full-version} -- same value, so only
// the source line can tell them apart.
const { collectPageTexts, collectPageExamples } = require('../refcheck/lib/source-refs')
const { parseNav, buildPlan, injectNavEntries, resolveNavIncludes, pageKey } = require('./lib/nav')
const { decodeHTML } = require('entities')
const { loadDispositions, isUnpublished, redirectRoute, urlBase, redirectPairs, publishedPageUrls, navInjectionsFor } = require('../lib/dispositions')
// Co-located image placement, computed from the reference graph. The converter
// is the only thing that knows every page's OUTPUT FILE (the nav plan decides
// it, not the URL), so it owns the plan and writes it out for extract-images.js.
const { planImagePlacement } = require('../lib/image-placement')
// Single-sources "which contexts render into flow text" with the marking pass, so
// prose reverse-mapping and marking can never disagree — see scanPageAttrs.
const { wrappableRefs } = require('../antora-extension/mark-attributes')
// Shared with the build-time example-attributes loader so the match key the
// converter computes reproduces exactly what the loader renders (no drift).
const substitute = require('../../plugins/lib/substitute-attributes')
// The ONE slicer, shared with the build-time tag-slice loader (see
// plugins/lib/slice-region.js) so the index and the build agree on every region.
const { allRegions } = require('../../plugins/lib/slice-region')
// The marking pass's branch grammar, reused so the converter's idea of an
// `ifdef`/`ifndef` snapshot branch cannot drift from the marker's.
const { branchesAt } = require('../antora-extension/mark-conditionals')
// Layout/source config shared with the reference checker (refcheck/run.js) so
// the two resolve source branches and output paths identically (no drift):
// which mirror + branch each component reads (NAV_SOURCES), which versions are
// emitted (VERSIONS / currentSegFor), and the version/path helpers.
const {
  NAV_SOURCES, currentSegFor, VERSIONS, markedAttrsFor,
  isNavless, isVersioned, refFor, versionsToProcess, outDirFor, urlToSlug,
} = require('../lib/layout')
const yaml2 = require('js-yaml')

// Antora attributes whose resolved value we single-source as a doc variable
// instead of baking it into every page (the firm no-baking principle: an
// attribute stays an attribute, resolved at render/build from one definition).
// Two shapes:
//   - Unversioned components (cloud): one global value. Used as link
//     destinations, so the converter emits a <Variable> in link mode; the value
//     lives in `variables` in src/variables.ts.
//   - Versioned components (operator): the value differs per version (e.g.
//     page-latest-supported-hazelcast is 5.7.0 at 5.18 but 5.4.0 at 5.12), so
//     it is single-sourced PER VERSION into `versionedVariables` and resolved
//     against the active version at render (<Variable>) or by file path at
//     build (the example-attributes webpack loader).
const SINGLE_SOURCE_ATTRS = {
  // page-cloud-console/signup are whole-href link destinations; page-cloud-
  // platform-version/full-version are version numbers that appear as a SUBSTRING
  // of a link URL/label (release-notes) — both must stay variables (no baking).
  cloud: ['page-cloud-console', 'page-cloud-signup', 'page-cloud-platform-version', 'full-version'],
  operator: ['page-latest-supported-hazelcast', 'page-latest-supported-mc', 'operator-chart-version'],
  // clc version numbers: full-version (its own release, per version) and
  // page-latest-supported-mc (curated per version). Distinctive values -> value
  // reverse-map, single-sourced per version like operator's.
  clc: ['full-version', 'page-latest-supported-mc'],
  // MC's own antora.yml set, all per-version: full-version (its own release),
  // page-latest-supported-hazelcast / -clc (curated compatibility numbers), the
  // two product-name strings, and mc-repo-swagger-branch (the git ref the
  // swagger_ui macro fetches the OpenAPI spec from — per-release, so it must not
  // bake). The product names are multi-word strings rather than version numbers,
  // but the reverse-map is source-scoped either way (only pages whose source
  // references the name are touched), and refcheck's `extra` finding is the gate
  // on a coincidental literal being caught up in it.
  'management-center': [
    'full-version',
    'page-latest-supported-hazelcast',
    'page-latest-supported-clc',
    'open-source-product-name',
    'enterprise-product-name',
    'mc-repo-swagger-branch',
  ],
  // Platform's set, all per-version. Three groups:
  //
  //   - VERSION NUMBERS reached through a link href or a code fence, which
  //     marking cannot carry: {os-version} alone is 199 href occurrences (the
  //     javadoc links) and 72 in code. The href path is exact rather than
  //     value-based (attrHrefTemplates reads the `{name}` out of the SOURCE's
  //     link target), so the three same-valued version attributes are
  //     unambiguous there; only their code occurrences rely on the value map,
  //     and MARKED_ATTRS covers their prose. {version} and {jet-version} have
  //     distinctive values and need no marking.
  //   - THE PRODUCT NAMES, whose prose occurrences are marked (they collide with
  //     literals) but whose handful of code occurrences still need the value map.
  //   - {hz-repo-swagger-branch}, the git ref the swagger_ui macro fetches its
  //     OpenAPI spec from, exactly as MC's mc-repo-swagger-branch above: per
  //     release, so it must not bake.
  //
  // {minimum-java-version} is the uncomfortable one: value `17`, and it is
  // referenced inside pom.xml fences (`<maven.compiler.release>{minimum-java-version}</…>`)
  // as well as in prose and in a docs.oracle.com href. The value map is therefore
  // scoped as tightly as the design allows -- to the pages whose SOURCE references
  // it (scanPageAttrs) -- and refcheck's `extra` finding is the gate on a
  // coincidental `17` in one of those fences being caught up in it.
  hazelcast: [
    'os-version', 'ee-version', 'full-version', 'version', 'jet-version',
    // {minor-version} is v/5.5-only in practice (later branches rewrote the
    // blocks) and referenced on ONE page, in three `subs="attributes+"` fences:
    // `hazelcast-client-config-{minor-version}.xsd`. Its value (`5.5`) is far too
    // common for the value map, but it does not need it -- all three lines are
    // covered by exact code-line templates, so `named` drops it from
    // codeValueVars and nothing goes hunting for a bare `5.5`.
    'minor-version',
    'minimum-java-version',
    'enterprise-product-name', 'open-source-product-name', 'java-client',
    'url-cloud-signup', 'hz-repo-swagger-branch',
    'page-latest-supported-mc', 'page-latest-supported-mc-installer',
    'page-latest-supported-po', 'page-latest-supported-clc',
    'page-latest-supported-cplusplus-client', 'page-latest-supported-csharp-client',
    'page-latest-supported-python-client', 'page-latest-supported-nodejs-client',
    'page-latest-supported-go-client',
    // {page-latest-supported-java-client} exists ONLY at 5.4 and 5.3 (5.4.0 and
    // 5.3.5): hz-docs renamed it to -java-client-new at 5.5, so the set assembled
    // while 5.5+ were the only live versions had no reason to carry it and every
    // occurrence baked -- clients/java, sql/sql-overview and 5.3's release note.
    // It also makes the collision in this family three-way rather than two: at 5.4
    // java, cplusplus AND csharp are all `5.4.0`. That costs nothing here because
    // every reference to it is inside a link href, where attrHrefTemplates reads
    // the `{name}` out of the SOURCE's own target and so cannot confuse same-valued
    // siblings -- which is also why leaving it OUT was what let the value map
    // mis-assign a java occurrence to csharp (refcheck's `extra` on sql-overview).
    'page-latest-supported-java-client',
  ],
}

// Build the single-sourced-attribute maps, reading resolved values from the
// manifest so the variable definition and the converter's reverse-map cannot
// drift. Spans every configured component so any run regenerates the complete
// definition. Returns:
//   flat            — Map(name->value) for unversioned components (cloud); the
//                     `variables` export.
//   linkValueToName — Map(component -> Map(value->name)): reverse map for
//                     single-sourced LINK hrefs (cloud), consulted by the <a>
//                     converter to emit <Variable> (link mode) instead of a URL.
//   versioned       — Map(component -> Map(versionName -> Map(name->value)))
//                     for versioned components; the `versionedVariables` export.
//                     Keyed by the Docusaurus version NAME ('current' for the
//                     main/-snapshot branch, else the release seg) so render-time
//                     <Variable> can look it up via useActivePluginAndVersion.
function collectVariables (manifest) {
  const flat = new Map()
  const flatComponents = new Map() // name -> the unversioned component that contributed it
  const linkValueToName = new Map()
  const versioned = new Map()
  for (const comp of manifest.components || []) {
    const single = SINGLE_SOURCE_ATTRS[comp.name] || []
    const marked = markedAttrsFor(comp.name)
    // Both classes become <Variable>s (single-sourced into variables.ts); they
    // differ only in HOW the converter re-inserts the reference -- SINGLE_SOURCE
    // by value reverse-map (distinctive URL/version values), MARKED by the
    // golden marker span (ambiguous prose values). Only SINGLE_SOURCE feeds the
    // value->name link reverse-map; a marked value must never be matched by value.
    const names = [...new Set([...single, ...marked])]
    if (!names.length) continue
    if (isVersioned(comp.name)) {
      const perVer = new Map()
      for (const v of comp.versions || []) {
        const attrs = v.attributes || {}
        const versionName = v.version === currentSegFor(comp.name) ? 'current' : v.version
        const nv = new Map()
        for (const name of names) if (attrs[name] != null) nv.set(name, String(attrs[name]))
        if (nv.size) perVer.set(versionName, nv)
      }
      if (perVer.size) versioned.set(comp.name, perVer)
    } else {
      const attrs = (comp.versions && comp.versions[0] && comp.versions[0].attributes) || {}
      const valueToName = new Map()
      for (const name of names) {
        const value = attrs[name]
        if (value == null) continue
        flat.set(name, String(value))
        flatComponents.set(name, comp.name)
        if (single.includes(name)) valueToName.set(String(value), name) // link reverse-map: SINGLE_SOURCE only
      }
      linkValueToName.set(comp.name, valueToName)
    }
  }
  return { flat, flatComponents, linkValueToName, versioned }
}

const mapToObj = (m) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)))

// The attribute names declared under `asciidoc.attributes` of a parsed YAML doc.
const asciidocAttrKeys = (parsed) => new Set(Object.keys((parsed && parsed.asciidoc && parsed.asciidoc.attributes) || {}))

// A component's OWN attribute names, from its docs repo's antora.yml (the
// component descriptor at `<component-root>/antora.yml`, e.g. docs/antora.yml).
// These are the repo-specific attributes, as opposed to the global playbook set.
function componentAttrKeys (component, sourcesDir) {
  const src = NAV_SOURCES[component]
  if (!src) return new Set()
  const root = path.posix.dirname(path.posix.dirname(path.posix.dirname(src.file))) // docs/modules/ROOT/nav.adoc -> docs
  const repoDir = path.join(sourcesDir, src.repo)
  try {
    const out = execFileSync('git', ['-C', repoDir, 'show', `${refFor(component, null) || 'main'}:${path.posix.join(root, 'antora.yml')}`], { encoding: 'utf8' })
    return asciidocAttrKeys(yaml2.load(out))
  } catch { return new Set() }
}

// The global playbook's attribute names (shared across every docs repo).
function playbookAttrKeys (playbookFile) {
  try { return asciidocAttrKeys(yaml2.load(fs.readFileSync(playbookFile, 'utf8'))) } catch { return new Set() }
}

// Group the flat (unversioned) variables by their SOURCE, so variables.ts records
// where each came from. A name defined in its component's own antora.yml is
// repo-specific (grouped under the component); otherwise, if it comes from the
// shared playbook, it is grouped under 'playbook'. Returns ordered groups
// (playbook first so a repo value overrides a playbook value in the flattened
// lookup) as [{ source, label, vars: Map(name->value) }].
function groupVariablesBySource (flat, flatComponents, opts) {
  const playbook = playbookAttrKeys(opts.playbookFile)
  const compKeys = new Map() // component -> Set of its own attr names (cached)
  const bySource = new Map() // source -> Map(name->value)
  const labelFor = new Map()
  const repoLabel = (comp) => {
    const repo = (NAV_SOURCES[comp] && NAV_SOURCES[comp].repo || '').replace(/\.git$/, '')
    return `hazelcast/${repo} — docs/antora.yml`
  }
  for (const [name, value] of flat) {
    const comp = flatComponents.get(name)
    if (comp && !compKeys.has(comp)) compKeys.set(comp, componentAttrKeys(comp, opts.sourcesDir))
    const inRepo = comp && compKeys.get(comp).has(name)
    const source = inRepo ? comp : (playbook.has(name) ? 'playbook' : comp || 'unknown')
    if (!bySource.has(source)) bySource.set(source, new Map())
    bySource.get(source).set(name, value)
    labelFor.set(source, source === 'playbook'
      ? 'Global Antora playbook (shared across all docs repos; the rest arrive later)'
      : repoLabel(source))
  }
  // playbook first, then components alphabetically.
  const order = [...bySource.keys()].sort((a, b) => (a === 'playbook' ? -1 : b === 'playbook' ? 1 : a.localeCompare(b)))
  return order.map((source) => ({ source, label: labelFor.get(source), vars: bySource.get(source) }))
}

// Write the SINGLE source of truth for doc variables: src/variables.ts.
// Consumed by React (<Variable>) via import, and by the build-
// time example-attributes loader via docusaurus.config importing it and passing
// the values as loader options — so there is exactly ONE file, no generated
// twin. The header is deliberately NOT "do not edit": during the migration this
// is bootstrapped from the Antora manifest, but it is a MAINTAINED file — after
// cutover its version values are updated on each product release (CI or by hand).
function writeVariablesFile (tsFile, groups, versioned) {
  const indent = (obj) => JSON.stringify(obj, null, 2).replace(/\n/g, '\n  ')
  const bySourceBody = groups
    .map(({ source, label, vars }) => `  // ${label}\n  ${JSON.stringify(source)}: ${indent(mapToObj(vars))},`)
    .join('\n')
  const versionedObj = {}
  for (const [comp, perVer] of [...versioned].sort(([a], [b]) => a.localeCompare(b))) {
    versionedObj[comp] = {}
    for (const [vName, nv] of perVer) versionedObj[comp][vName] = mapToObj(nv)
  }
  const ts = '// Single source of truth for doc variables — values that must stay\n' +
    '// attributes, never baked (e.g. per-version product version numbers).\n' +
    '// Bootstrapped from the Antora manifest by migration/converter during the\n' +
    '// migration; MAINTAIN HERE going forward — update the version values on each\n' +
    '// product release (via CI or by hand).\n' +
    '//\n' +
    '// `variablesBySource`: global/unversioned values grouped by ORIGIN — each\n' +
    '// docs repo\'s own antora.yml, or the shared Antora playbook. Grouping is for\n' +
    '// context/provenance; `variables` is the flat lookup the app consumes.\n' +
    '// `versionedVariables[component][versionName]`: per-version values\n' +
    '// (versionName is \'current\' for the current docs version, else the release).\n' +
    'export const variablesBySource: Record<string, Record<string, string>> = {\n' +
      bySourceBody + '\n};\n\n' +
    '// Flattened lookup consumed by <Variable> (src/components/Variable.tsx) and\n' +
    '// the example-attributes loader. Merged in group order, so a docs-repo value\n' +
    '// overrides a playbook value on the same name.\n' +
    'export const variables: Record<string, string> = Object.assign(\n' +
    '  {},\n' +
    '  ...Object.values(variablesBySource),\n' +
    ');\n\n' +
    'export const versionedVariables: Record<string, Record<string, Record<string, string>>> = ' +
      JSON.stringify(versionedObj, null, 2) + ';\n'
  fs.mkdirSync(path.dirname(tsFile), { recursive: true })
  fs.writeFileSync(tsFile, ts)
}

// Trailing slash off (config `trailingSlash: false`), so a redirect path must
// have no trailing slash — except the site root. The Antora alias for a
// component/version start page carries a trailing slash (e.g. `/cloud/`), which
// would otherwise not match the slash-less canonical route.
function normalizeRoute (url) {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url
}

// Docusaurus client redirects, from BOTH sources: page-aliases and the
// `redirect` orphan decisions. Every alias resource in the
// manifest records the OLD (aliased) URL plus `aliasTo`, the current page it
// redirects to (see emit-manifest). We emit one {from, to} per alias for the
// converted components only — the client-redirects plugin fails the build if a
// `to` is not a real route, and an alias always targets a page in its own
// component, so gating on the components the converter lays out (NAV_SOURCES)
// guarantees the `to` component is built. For a VERSIONED component we further
// gate on `liveSegs`: only versions actually built this run are real routes
// (frozen versions are served elsewhere). Spans all converted components so any
// run regenerates the complete src/redirects.ts, like variables.ts.
function collectRedirects (manifest, liveSegsByComponent, dispositions) {
  const converted = new Set(Object.keys(NAV_SOURCES))
  // liveSegs === null => unversioned component (no gate); a Set => versioned,
  // keep only resources whose version is one we built.
  const isLive = (r) => {
    if (!converted.has(r.component)) return false
    const liveSegs = liveSegsByComponent.get(r.component)
    return !(liveSegs && !liveSegs.has(r.version))
  }
  // A page-alias whose TARGET is a page an orphan decision withholds has nowhere
  // to land: the alias URL would redirect into a 404, and the client-redirects
  // plugin fails the whole build on a `to` that is not a real route. Drop it --
  // an alias is just another URL for the page it points at, so when that page is
  // dropped its aliases go with it. (Real case: getting-started/resources is
  // drop-404 and carried `:page-aliases: overview:resources.adoc`.)
  const published = publishedPageUrls(dispositions, manifest, isLive)
  const redirects = []
  for (const r of manifest.resources || []) {
    if (r.family !== 'alias' || !r.aliasTo || !isLive(r)) continue
    const from = normalizeRoute(r.url)
    const to = normalizeRoute(r.aliasTo)
    if (from === to || !published.has(to)) continue
    redirects.push({ from, to })
  }
  // Orphan triage `redirect` decisions land in the same table: the page is not
  // emitted, so this entry is the only thing keeping its URL alive. Resolved in
  // lib/dispositions (redirectPairs), next to the decision it acts on.
  redirects.push(...redirectPairs(dispositions, manifest, isLive))
  redirects.sort((a, b) => a.from.localeCompare(b.from))
  return redirects
}

function writeRedirectsFile (file, redirects) {
  const body = redirects
    .map((r) => `  { from: ${JSON.stringify(r.from)}, to: ${JSON.stringify(r.to)} },`)
    .join('\n')
  const out = '// Generated by migration/converter — do not edit by hand.\n' +
    '// Client redirects consumed by @docusaurus/plugin-client-redirects in\n' +
    '// docusaurus.config.ts. Two sources: page-aliases (old Antora URL → current\n' +
    '// page) and `redirect` orphan decisions (a page the migration stopped\n' +
    '// publishing → the page that replaces it).\n' +
    'export const redirects: {from: string; to: string}[] = [\n' + body + '\n];\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, out)
}

// NOTE: api/cloud.json is NOT generated here. The cloud-* console-index data is
// SEEDED into cloud MDX frontmatter (see frontmatter(), cloud_* keys), and the
// file itself is emitted at Docusaurus build time by the permanent
// new-docs/plugins/cloud-console-index plugin (the replacement for the Antora
// api-json.js extension). This keeps the artifact regenerable after the migration
// tooling is deleted.

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  const component = val('--component', 'cloud')
  const releasesArg = val('--releases', null)
  return {
    component,
    id: val('--id', null),
    releases: releasesArg ? releasesArg.split(',').map((s) => s.trim()).filter(Boolean) : null,
    goldenDir: path.resolve(val('--golden', 'build/golden')),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    sourcesDir: path.resolve(val('--sources', '.sources')),
    playbookFile: path.resolve(val('--playbook', path.join('antora', 'index-playbook.yml'))),
    outRoot: path.resolve(val('--out-root', '..')),
    variablesFile: path.resolve(val('--variables', path.join('..', 'src', 'variables.ts'))),
    redirectsFile: path.resolve(val('--redirects', path.join('..', 'src', 'redirects.ts'))),
    dry: has('--dry'),
    verbose: has('--verbose'),
  }
}

// url -> page-resource; and a key -> title map for the nav planner, both scoped
// to ONE (component, version). Bare stems like "overview" recur across
// components, versions AND modules (often literally titled "Overview"), so an
// unscoped or module-blind map would clobber the titles the nav labels are drawn
// from — hence the module-qualified plan key (see pageKey in lib/nav.js).
// A component-version's FULL resolved attribute table from the manifest (not just
// the single-sourced subset): what Antora would resolve on that branch.
function attrTableFor (manifest, component, seg) {
  const comp = (manifest.components || []).find((c) => c.name === component)
  if (!comp) return {}
  const v = (comp.versions || []).find((x) => (x.version || '') === (seg == null ? '' : seg))
  return (v && v.attributes) || {}
}

// Resolve {attribute} references in a chunk of AsciiDoc, via the substituter
// shared with the example loader and the swizzled CodeBlock so the three cannot
// drift. Null-safe: nav.adoc may be missing on a branch.
const withAttrs = (text, lookup) => (text == null ? text : substitute(text, lookup))

function indexManifest (manifest, component, seg) {
  const byUrl = new Map()
  const titleByKey = new Map()
  for (const r of manifest.resources || []) {
    if (r.family !== 'page' || !r.url || r.component !== component) continue
    if (seg && r.version !== seg) continue
    byUrl.set(r.url, r)
    // Decoded here, not at the frontmatter: this map also supplies nav LABELS and
    // category folder names, so a raw entity would reach the sidebar and the paths.
    if (r.title) titleByKey.set(keyOf(r), titleText(r.title))
  }
  return { byUrl, titleByKey }
}

// A page resource's plan key. Derived from the manifest record's own module +
// relative path (NOT from its URL), so it is exactly the coordinate the nav writes.
const keyOf = (r) => pageKey(r.module, String(r.relative || '').replace(/\.adoc$/, ''))

// Co-located example files -> a content-addressed index for the converter:
// canonical slice content -> { file, query, conums }. The converter matches a
// golden code block's text against this to decide whether to import the file
// (single-sourced) instead of baking a fence. Empty when the component has no
// examples or extract-examples has not run.
//
// One entry per SLICE, not per file. Operator includes whole files, but
// Platform's Java is tag-sliced: one file feeds many pages at many regions
// (cp/CpSubsystemAPI.java alone is included 11 times at 10 tags). Each slice is
// indexed with the import query that reproduces it (`?tag=…`, `?lines=…`,
// `&indent=0`), which the build-time tag-slice loader re-derives from the same
// shared slicer -- so what the converter matched and what webpack emits cannot
// diverge.
//
// The co-located files are BYTE-FAITHFUL (Antora {attribute} placeholders and
// native `<N>` conum markers intact), but the golden shows Antora's resolved
// value and renders conums as `(N)`. So the match key reproduces the golden:
// substitute attributes with this version's values (`lookup`), then rewrite a
// trailing `<N>` conum marker to `(N)`. `conums` is read off the SLICE, not the
// file: a file may carry callouts in one region and none in another.
// Where a component's example files live, and how a page imports them.
// Default: co-located in an `examples/` dir under the component's own out tree.
// TUTORIALS are the exception -- their examples are the guide repos' RUNNABLE
// project files (the repos symlink `src/`, `client/` etc. into Antora's
// examples dir), so there is no committed copy here: plugins/tutorial-examples
// stages them from the pinned repo on every build, and pages import them
// site-absolutely out of that staging dir.
const EXAMPLES_STAGING = '.tutorial-examples'

function examplesConfig (component, outRoot, outDir) {
  if (component === 'tutorials') {
    return { dir: path.join(outRoot, EXAMPLES_STAGING), importBase: `@site/${EXAMPLES_STAGING}` }
  }
  return { dir: path.join(outDir, 'examples'), importBase: null }
}

function loadExamples (examplesDir, lookup) {
  const byContent = new Map()
  if (!fs.existsSync(examplesDir)) return byContent
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      const raw = fs.readFileSync(p, 'utf8')
      const rel = path.relative(examplesDir, p).split(path.sep).join('/')
      for (const { query, content } of allRegions(raw)) {
        const key = exampleKey(content, lookup)
        if (!byContent.has(key)) byContent.set(key, [])
        byContent.get(key).push({ file: rel, query, conums: CONUM_LINE.test(content) })
      }
    }
  }
  walk(examplesDir)
  // Shortest query first WITHIN a file: two queries only ever land on the same
  // key when they yield identical text, and then the simpler selector is the
  // honest one (a whole-file include should not be recorded as `?indent=0`).
  for (const list of byContent.values()) list.sort((a, b) => a.query.length - b.query.length)
  return byContent
}

// A trailing `<N>` callout marker on its own line (native Asciidoctor conum).
const CONUM_LINE = /<\d+>[ \t]*$/m

// Canonical match key for a co-located example file: resolve attributes to this
// version's values, rewrite trailing `<N>` conums to the golden's `(N)`, then
// strip trailing blank lines/newlines (Antora drops an included file's trailing
// newline; the golden <pre> text is normalized the same way).
function exampleKey (raw, lookup) {
  const resolved = substitute(raw, lookup || {})
  const conumed = resolved.replace(/<(\d+)>([ \t]*)$/gm, '($1)$2')
  return normalizeCode(conumed)
}

// Match key for golden code content: strip trailing blank lines/newlines. Line
// content is otherwise preserved verbatim (the golden already carries resolved
// attributes and `(N)` conums, so it needs no further canonicalization).
const normalizeCode = (s) => s.replace(/\n+$/, '')

// The component's nav.adoc for one version, with its module-partial includes
// resolved (see resolveNavIncludes) so the nav the converter plans from is the
// one Antora renders. Both reads go through the same frozen git ref, so a
// version's nav and its partials can never come from different branches.
//
// A missing nav.adoc is a WARNING and a flat layout, as before. A nav.adoc that
// exists but whose includes cannot be resolved is an ERROR: falling back to flat
// there would quietly discard a sidebar tree we did find, which is worse than not
// finding one at all.
function loadNavAdoc (component, seg, sourcesDir) {
  const src = NAV_SOURCES[component]
  if (!src) return null
  const ref = src.refFor ? src.refFor(seg) : src.ref
  const repoDir = path.join(sourcesDir, src.repo)
  const show = (file) => {
    try {
      return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${file}`], { encoding: 'utf8' })
    } catch {
      return null
    }
  }
  let adoc
  try {
    adoc = execFileSync('git', ['-C', repoDir, 'show', `${ref}:${src.file}`], { encoding: 'utf8' })
  } catch (err) {
    console.warn(`[convert] could not read nav.adoc for ${component}@${seg || '-'} (${err.message.split('\n')[0]}); falling back to flat layout`)
    return null
  }
  // `docs/modules/ROOT/nav.adoc` -> `docs/modules`, the root every module's
  // `<module>/partials/<path>` hangs off. A partial with no module coordinate
  // belongs to the nav's own module (ROOT here), exactly as Antora resolves it.
  const modulesRoot = path.posix.dirname(path.posix.dirname(src.file))
  const navModule = path.posix.basename(path.posix.dirname(src.file))
  try {
    return resolveNavIncludes(adoc, (module, relPath) => show(`${modulesRoot}/${module || navModule}/partials/${relPath}`))
  } catch (err) {
    throw new Error(`nav.adoc for ${component}@${seg || '-'} (${ref}): ${err.message}`)
  }
}

// Which SINGLE_SOURCE attributes each page's SOURCE references ({name}), split by
// WHERE it references them — Map(stem -> { all: Set(name), prose: Set(name) }).
// The converter only reverse-maps a value on pages that genuinely use that
// attribute, so a coincidental match on an unrelated page is never touched. One
// `git grep -l` per attribute against the version's branch to find the files,
// then each file's text is classified.
//
// `prose` is the narrower set: the attributes this page references in a context
// that RENDERS INTO FLOW TEXT. It gates the prose value reverse-map, and the
// distinction matters because prose matching is the one mechanism that can fire
// where no reference exists. Where a page references an attribute ONLY inside
// verbatim blocks it needs NO prose matching at all, so leaving the value in the
// prose map is pure false-positive surface: any literal on that page equal to the
// version would be variableised. Excluding it removes that exposure and can lose
// nothing, because there is no flow-text reference to put back. The blocks are
// served by the CODE map, which keeps every name.
//
// This fires on real pages: `operator-chart-version` is `----`-fenced-only on
// operator's get-started (all 8 live versions) and air-gapped-env (5.14, 5.15).
// It does NOT fire on image-registry, whose blocks are BACKTICK fences that the
// classifier — like the marking pass, by design — reads as flow text, so that
// page keeps prose matching exactly as before.
//
// The classifier is `wrappableRefs` from the marking pass, deliberately: "which
// contexts render into flow text" then has ONE definition shared by marking and
// by prose matching, and the two cannot drift apart. It is conservative in the
// right direction — a reference inside a `link:`/`xref:` macro target sits on a
// flow line and so counts as prose, which keeps today's behaviour for cloud's
// `page-cloud-platform-version` and clc's `page-latest-supported-mc` rather than
// silently changing how their links resolve.
// Keyed by the module-qualified plan KEY, and scanned across EVERY module: the
// nav.adoc path only tells us where the nav lives (always ROOT), not where the
// pages live. Scoping the grep to ROOT's own `pages/` would silently find nothing
// on a multi-module component like MC, whose 102 pages are spread over 11 modules
// — every single-sourced attribute would then look unreferenced and bake.
function scanPageAttrs (component, seg, sourcesDir) {
  const names = SINGLE_SOURCE_ATTRS[component] || []
  const src = NAV_SOURCES[component]
  const byKey = new Map()
  if (!names.length || !src) return byKey
  const ref = src.refFor ? src.refFor(seg) : src.ref
  const repoDir = path.join(sourcesDir, src.repo)
  // `docs/modules/ROOT/nav.adoc` -> `docs/modules`: every module's tree.
  const modulesGlob = path.posix.dirname(path.posix.dirname(src.file))
  // `<modulesGlob>/<module>/pages/<relative>.adoc` -> the page's plan key.
  const PAGE_PATH = new RegExp(`^${modulesGlob}/([^/]+)/pages/(.+)\\.adoc$`)
  const textCache = new Map()
  const textOf = (file) => {
    if (!textCache.has(file)) {
      let text = ''
      try { text = execFileSync('git', ['-C', repoDir, 'show', `${ref}:${file}`], { encoding: 'utf8' }) } catch {}
      textCache.set(file, text)
    }
    return textCache.get(file)
  }
  for (const name of names) {
    let out
    try {
      out = execFileSync('git', ['-C', repoDir, 'grep', '-l', '--fixed-strings', `{${name}}`, ref, '--', modulesGlob], { encoding: 'utf8' })
    } catch { continue } // no match for this attr on this branch
    for (const line of out.split('\n')) {
      if (!line) continue
      const idx = line.indexOf(':') // `ref:path`
      const file = idx === -1 ? line : line.slice(idx + 1)
      const m = file.match(PAGE_PATH)
      if (!m) continue // a partial/example/nav, not a page
      const key = pageKey(m[1], m[2])
      if (!byKey.has(key)) byKey.set(key, { all: new Set(), prose: new Set(), hrefs: new Set() })
      const rec = byKey.get(key)
      rec.all.add(name)
      if (wrappableRefs(textOf(file), [name]).has(name)) rec.prose.add(name)
      // Link targets written with an `{attribute}` in them, for the exact-match
      // href path (see hrefVars below). Collected from the same text, and a Set
      // so revisiting this file under another attribute name is idempotent.
      for (const t of attrHrefTemplates(textOf(file))) rec.hrefs.add(t)
    }
  }
  return byKey
}

// value->name map of the attrs a page references (source-scoped), resolved to
// this version's values — passed to the converter to reverse-map prose/code.
//
// A value claimed by TWO names identifies neither, so it is dropped rather than
// let the last writer win. hazelcast holds `5.8.0-SNAPSHOT` in {os-version},
// {ee-version} AND {full-version} at once, and 14 pages reference two of the
// three: guessing put 16 `{os-version}` occurrences out as `{ee-version}` on
// deploying-with-docker alone. Since the three genuinely diverge (at 5.5,
// os-version is 5.5.0 while ee-version is 5.5.10), a guess is not a cosmetic
// mis-naming — it prints the wrong version, and fidelity cannot see it because
// both names render a correct-looking value today.
//
// Dropping the value does not mean losing the reference: the exact paths still
// name it (hrefVars for a link target, codeVars for a verbatim line), and where
// neither reaches it, refcheck reports it baked — a visible finding instead of a
// silent error.
function buildPageVars (names, lookup) {
  const m = new Map()
  const collided = new Set()
  if (!names) return m
  for (const name of names) {
    const v = lookup[name]
    if (v == null || v === '') continue
    const value = String(v)
    if (m.has(value) && m.get(value) !== name) collided.add(value)
    else m.set(value, name)
  }
  for (const value of collided) m.delete(value)
  return m
}

// --- snapshot conditionals: give every version tree BOTH branches ------------
//
// A paired `ifdef::snapshot[]` / `ifndef::snapshot[]` renders ONE half per
// version: the snapshot render carries the then-branch, a release render the
// else-branch. So each tree's golden shows only its own half, and wrapping what is
// there leaves every tree missing the other one. That matters in two ways:
//
//   * the CURRENT tree is what `docusaurus docs:version` copies, so a cut would
//     produce a release with the snapshot half hidden and no else half at all;
//   * MC@5.9 renders the THEN half today (its antora.yml wrongly sets
//     `snapshot: true`), so as a released version it would show neither.
//
// The missing half is not lost — this run has every version's golden in hand, so
// it is taken from a version whose render kept it. Two rules make that safe:
//   1. the branch's SOURCE text must be identical on both branches (the pinned
//      sources are read per version anyway), else the donor is not what this
//      version would have rendered — skipped and reported, never guessed;
//   2. the donor's region is converted with the DONOR's variable maps but the
//      RECIPIENT's page URL. Values are baked per version, so mapping them back to
//      references needs the donor's values; link resolution depends on where the
//      page LIVES, so it needs the recipient's. Getting this pair the wrong way
//      round bakes the donor's version number, or points relative links at the
//      donor's tree.
// Because the spliced region carries `{attribute}` references rather than values,
// it is correct in the recipient at any version — which is only true now that
// href templates recover `…/tree/v{page-latest-supported-hazelcast}.0/…`.
// The sentinel token for a branch kind: `ifdef` regions are marked `hz-if`,
// `ifndef` regions `hz-ifnot` (mark-conditionals.js START/NOT_START).
const SENTINEL_KIND = { ifdef: 'if', ifndef: 'ifnot' }
const condRegionRe = (kind) => {
  const s = SENTINEL_KIND[kind]
  return new RegExp(`<!--hz-${s}:snapshot:start-->[\\s\\S]*?<!--hz-${s}:snapshot:end-->`, 'g')
}
const condRegions = (html, kind) => html.match(condRegionRe(kind)) || []

// The body text of a source file's `ifdef`/`ifndef` snapshot branch, or null.
// Uses the marking pass's own grammar so the two cannot disagree about what a
// branch is.
function sourceBranchText (text, kind) {
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const bs = branchesAt(lines, i)
    if (!bs) continue
    const b = bs.find((x) => x.kind === kind)
    if (b) return lines.slice(b.start + 1, b.end).join('\n').trim()
    i = bs[bs.length - 1].end
  }
  return null
}

// A page resource's source path in its repo, e.g.
// `docs/modules/clusters/pages/update-config.adoc`.
function sourcePathFor (component, rec) {
  const src = NAV_SOURCES[component]
  if (!src || !rec || !rec.module || !rec.relative) return null
  const modules = path.posix.dirname(path.posix.dirname(src.file)) // .../modules
  return `${modules}/${rec.module}/pages/${rec.relative}`
}

// Resolved URL -> the source link target that produced it, for the page's own
// targets that carry an `{attribute}` reference. Substituting this version's
// values into the template reproduces exactly the href Antora wrote into the
// golden, so the converter recognises it by string equality and re-emits the
// template — the only way to recover a reference the author followed with more
// text (`…/tree/v{page-latest-supported-hazelcast}.0/…`,
// `{page-cloud-console}settings/developer`), which the value reverse-map must
// refuse because it cannot tell that `.0` continues the URL but not the version.
//
// A template is only used when EVERY name in it is single-sourced on this page
// (`all`): emitting a `{name}` the site has no variable for would put literal
// braces in an href. Templates that substitute to themselves (nothing known)
// are dropped for the same reason.

// Both exact template maps, built from the pages' whole INCLUDE CLOSURE:
//
//   code   { blocks, lines } — a verbatim line/block, resolved-text -> source text.
//   hrefs  a link macro's target, resolved URL -> source target.
//
// The closure rather than the page file alone, because a reference reaching a page
// through an `include::` is invisible otherwise -- and that is not a corner case:
// install-enterprise's `setLicenseKey()` javadoc link arrives via
// `include::deploy:enterprise-licenses.adoc[tag=install-license]`, and the two
// `{ee-version}` fences on get-started-enterprise arrive via
// `include::install-enterprise.adoc[tag=docker]`. Both baked while collection
// stopped at the page file.
//
// `known` is the component's single-sourced set rather than a per-page one, for the
// same reason: an attribute a page only touches through an include is not in that
// page's own list, and gating on it would drop exactly the templates the closure was
// walked for.
//
// `resources` is a list so a FACTORED PARTIAL can be built from the union of its
// consuming pages' closures -- a partial is converted once, on its own, and had no
// template maps at all until now.
function buildTemplates (component, resources, seg, sourcesDir, lookup) {
  const known = new Set(SINGLE_SOURCE_ATTRS[component] || [])
  const code = { blocks: new Map(), lines: new Map() }
  if (!known.size) return { code, hrefs: new Map(), named: new Set() }
  const lines = new Set()
  const blocks = new Set()
  const hrefs = new Set()
  for (const resource of resources) {
    if (!resource) continue
    for (const text of collectPageTexts(resource, seg, sourcesDir, lookup)) {
      const t = attrCodeTemplates(text)
      for (const line of t.lines) lines.add(line)
      for (const block of t.blocks) blocks.add(block)
      for (const href of attrHrefTemplates(text)) hrefs.add(href)
    }
  }
  const resolvedCode = buildCodeTemplates({ lines, blocks }, known, lookup, substitute)
  // The names the code templates account for. Where a name is templated, the value
  // map must NOT also hunt for its value in the rest of the page's code: the source
  // has just said exactly which code lines reference it, so any other line matching
  // the value is a coincidence. `{minimum-java-version}` is why this matters -- it
  // resolves to the bare `17`, and on two pages the map turned a literal 17 in
  // sample OUTPUT ("Kinesis got 17 tweets per second") into a reference. A missed
  // reference bakes and the gate says so; a coincidental one silently changes with
  // the attribute.
  const named = new Set()
  for (const map of [resolvedCode.blocks, resolvedCode.lines]) {
    for (const tpl of map.values()) {
      for (const m of tpl.matchAll(/\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g)) named.add(m[1])
    }
  }
  return { code: resolvedCode, hrefs: resolveTemplates(hrefs, known, lookup, substitute), named }
}

// `pageVars` minus the names the code templates already account for — the value
// map used for FENCE lines no template covered. Prose and hrefs are unaffected:
// they have their own maps and their own exact paths.
function codeValueVarsFor (pageVars, named) {
  if (!named || !named.size) return pageVars
  return new Map([...pageVars].filter(([, name]) => !named.has(name)))
}

// The subset of `pageVars` that may be reverse-mapped in PROSE. Two exclusions,
// both saying "this attribute's prose references do not come from value matching":
//
//   1. MARKED attributes. Marking (antora-extension/mark-attributes.js) records a
//      reference's exact POSITION and covers every flow-text context — prose,
//      table cells, inline code, headings. So the value match is redundant by
//      construction, and anything it finds on top of the markers is a coincidental
//      literal (operator's compatibility matrix; see MARKED_ATTRS in
//      lib/layout.js) that must stay literal.
//   2. Attributes this page references ONLY in verbatim blocks (`prose` from
//      scanPageAttrs). There is no flow-text reference to restore, so a prose
//      match here can only ever be a false positive.
//
// What neither exclusion touches is the CODE map: `pageVars` stays whole, so
// image-registry's yaml block still becomes a `vars` template. A marker cannot
// substitute for it there — either because the pass skips the block (`----` and
// friends) or because, in a BACKTICK fence, which the pass does enter, the span
// does not survive the fence path as a reference. Dropping a marked attr from
// SINGLE_SOURCE therefore bakes it; see the note in lib/layout.js MARKED_ATTRS.
function proseVarsFor (pageVars, proseNames, marked) {
  return new Map([...pageVars].filter(([, name]) =>
    proseNames.has(name) && !marked.includes(name)))
}

// There is no still-baked audit here any more. It searched each page body for an
// attribute's resolved VALUE and warned wherever it found one, which made it
// permanently, unfixably noisy: operator's CRD default-values table genuinely
// contains the literal `5.7.0`, so every run warned about a page that had nothing
// wrong with it, and the reader learned to ignore the whole category. The gate
// (`npm run check:refs`) supersedes it and cannot make that mistake: expectations
// come from the census render's tokens, so nothing is ever matched on a real
// value, and it counts occurrences rather than warning on presence.

function frontmatter (title, { derived, slug, sidebarLabel, sidebarPosition, unlisted, noSidebar, badges, cloud } = {}) {
  const lines = ['---', `title: ${yaml(title)}`]
  if (sidebarLabel) lines.push(`sidebar_label: ${yaml(sidebarLabel)}`)
  if (sidebarPosition != null) lines.push(`sidebar_position: ${sidebarPosition}`)
  if (slug) lines.push(`slug: ${slug}`)
  // Page-level badges (e.g. `dedicated: true`), carried from the page header via
  // the manifest. The front-end BADGES registry keys off these frontmatter keys.
  if (badges) for (const key of badges) lines.push(`${key}: true`)
  // Console-index metadata (cloud-* page header attributes → cloud_* frontmatter),
  // carried from the manifest. NOT rendered — consumed at build time by the
  // cloud-console-index Docusaurus plugin, which emits /api/cloud.json from these
  // (the permanent replacement for the Antora api-json.js extension). Kept as raw
  // strings (a `|` splits one page into multiple console entries). This seeds the
  // data into new-docs so cloud.json survives deletion of the migration tooling.
  if (cloud) for (const [attr, val] of Object.entries(cloud)) lines.push(`${attr.replace(/-/g, '_')}: ${yaml(val)}`)
  // Orphan pages: present in Antora (served at their URL) but absent from the
  // nav. `unlisted` mirrors that exactly -- the URL still resolves, but the page
  // is kept out of the sidebar, search, and sitemap.
  if (unlisted) lines.push('unlisted: true')
  // A NAV-LESS component has no sidebar to show, and Antora serves its pages
  // through a TOC-only layout with neither a nav tree nor prev/next. Setting
  // `displayed_sidebar: null` reproduces both at once: plugin-content-docs
  // resolves a null sidebar name to emptySidebarNavigation(), which drops the
  // sidebar AND the pagination that is derived from it.
  if (noSidebar) lines.push('displayed_sidebar: null')
  if (derived) lines.push('hide_title: true')
  lines.push('---')
  return lines.join('\n')
}

const yaml = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

// A page title as a READER sees it, not as HTML. Both sources of a title are
// already-converted HTML and so carry entities: Antora's manifest stores
// Asciidoctor's `doctitle` (`C&#43;&#43; Client`, `What&#8217;s New in ...`), and
// deriveTitle scrapes an <h1>. Frontmatter is YAML, not HTML, so an entity left
// in there reaches the browser tab, the sidebar and the search index literally.
// Decoded in ONE place, through the same entity table cheerio uses, rather than
// the hand-rolled two-entity replace this used to carry -- which covered the
// curly apostrophe and silently missed `&#43;` and `&amp;`.
const titleText = (s) => decodeHTML(String(s)).replace(/\s+/g, ' ').trim()

function deriveTitle (html) {
  const m = html.match(/<h[1-6][^>]*>(?:<a[^>]*><\/a>)?([\s\S]*?)<\/h[1-6]>/i)
  if (!m) return null
  return titleText(m[1].replace(/<[^>]+>/g, ''))
}

// Convert ONE (component, version) into its own docs tree. Returns a small
// summary for logging. All version scoping lives here; main() orchestrates the
// version loop and the site-wide (variables/redirects/versions) files.
// The output file (relative to the component out dir) a golden page converts to,
// derived from its nav entry — the SINGLE derivation used both to emit the page
// and to build the URL->file map, so the map can't drift from what is written.
//
// `key` is the module-qualified plan key; a page with no nav entry (an orphan)
// falls back to the key's own shape as a path, so a multi-module component's
// orphans land under their module rather than all piling into the tree root where
// two same-named pages from different modules would overwrite each other. The
// file path is free to differ from the nav layout either way: the URL is preserved
// by the page's `slug`, never by where the file sits.
function relFileForPage (p, byUrl, plan) {
  const rec = byUrl.get(p.url)
  const key = rec
    ? keyOf(rec)
    : (p.url.replace(/\/$/, '').split('/').pop() || 'index')
  const stem = key.split(':').pop().split('/').pop()
  const entry = plan.pages.get(key)
  return { key, stem, rec, entry, relFile: entry ? entry.relFile : key.replace(/:/g, '/') + '.mdx' }
}

// Every internal image URL a golden page references, resolved against the page's
// own URL exactly as the converter resolves it when emitting the reference — so
// the placement plan and the emitted `src` cannot be computed from different
// sets.
function imageUrlsIn (html, pageUrl) {
  const out = []
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)) {
    const r = resolveHref(m[1], pageUrl)
    if (r.kind === 'internal') out.push(r.path)
  }
  return out
}

// Remove the files a previous conversion of this version tree wrote — `.mdx`
// pages/partials and `_category_.json` descriptors — and then any directory that
// leaves empty, so a page moved by a nav change does not linger at its old path.
//
// It deletes by WHAT IT WROTE rather than by clearing the tree and sparing a
// couple of known asset folder names, because co-located assets do not all sit at
// the tree root: a multi-module component (MC) has `<module>/images/`, and
// skip-listing `images` at the top level only meant `troubleshoot/` was removed
// wholesale, images included — which the build then caught as a broken image
// reference (onBrokenMarkdownImages: 'throw'), the good outcome of a bad delete.
// Anything this converter does not produce is now left alone wherever it sits.
function pruneGenerated (dir) {
  if (!fs.existsSync(dir)) return false // nothing here
  let kept = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (pruneGenerated(p)) kept++
      continue
    }
    if (e.name.endsWith('.mdx') || e.name === '_category_.json') fs.rmSync(p, { force: true })
    else kept++
  }
  if (kept === 0) { fs.rmdirSync(dir); return false }
  return true
}

function convertVersion (ver, ctx) {
  const { component, manifest, allGoldenForComponent, opts } = ctx
  const { seg, kind } = ver

  // This version's single-sourced attribute values, for resolving {attribute}
  // placeholders in co-located example files when computing the match key. Keyed
  // by the Docusaurus version NAME ('current' for the current branch, else the
  // seg), matching versionedVariables; global (unversioned) values fill in
  // behind. `kind` already distinguishes current from a release, so we key off it
  // rather than re-deriving the current seg here.
  // Parameterised by version so a DONOR version's values can be resolved too, for
  // conditional-branch splicing (see withBothConditionalBranches).
  const lookupFor = (v) => {
    const name = v.seg == null ? null : (v.kind === 'current' ? 'current' : v.seg)
    const per = (name && ctx.versioned.get(component) && ctx.versioned.get(component).get(name)) || new Map()
    return { ...Object.fromEntries(ctx.flat), ...Object.fromEntries(per) }
  }
  const exampleLookup = lookupFor({ seg, kind })
  const outDir = outDirFor(opts.outRoot, component, ver)

  const { byUrl, titleByKey } = indexManifest(manifest, component, seg)

  // Nav-driven plan (file layout, sidebar metadata, categories).
  // `keep-in-nav` orphans are injected first, so a page merely forgotten upstream
  // is planned exactly like any nav page. Only inject where the page actually
  // exists in THIS version (titleByKey is this version's manifest): an older
  // branch may predate the page, and a nav entry pointing at nothing would be a
  // broken link rather than a fix.
  // Nav labels are the one place attributes are deliberately BAKED. Everything
  // the nav produces lands in YAML — a page's frontmatter `sidebar_label:` and a
  // category's `_category_.json` label — and YAML is not interpolated by anything,
  // so a surviving `{name}` reaches the reader as literal braces. Antora resolves
  // these when it renders the nav; the converter reads nav.adoc raw, so it has to
  // do the same. Resolving the whole nav source (not just the labels) matches what
  // Antora does and covers xref targets too. Unknown names are left literal by
  // `substitute`, exactly as Antora leaves an undefined attribute.
  // refcheck's `inert` finding is the gate on this: a token in frontmatter is a
  // failure to bake, not a reference.
  const navAttrs = attrTableFor(manifest, component, seg)
  const navAdoc = withAttrs(loadNavAdoc(component, seg, opts.sourcesDir), navAttrs)
  const injections = navInjectionsFor(ctx.dispositions, component, seg).filter((i) => titleByKey.has(i.key))
  const plan = navAdoc
    ? buildPlan(parseNav(injectNavEntries(navAdoc, injections)), titleByKey)
    : { pages: new Map(), categories: [], duplicates: [] }

  const allPages = allGoldenForComponent.filter((p) => (seg ? p.versionSeg === seg : true))
  let pages = allPages
  if (opts.id) pages = pages.filter((p) => p.url === opts.id)
  if (pages.length === 0) return null // nothing for this version (e.g. --id in another version)

  // URL -> output file for EVERY page in this version. A same-component
  // same-version link is then emitted as a relative path to the target .mdx
  // FILE rather than an absolute /<comp>/<version>/ route: relative file links
  // survive `docusaurus docs:version` (which COPIES the current docs' files into
  // the new version folder — an absolute link would stay frozen on the old
  // version). Spans allPages (not the --id subset) so links resolve in a
  // single-page run too. Trailing-slash variants keyed for robust lookup.
  // Versioned instances only (seg != null): an unversioned component (cloud)
  // has no version-cut lifecycle, so leave its absolute links unchanged. An
  // empty map => every lookup misses => absolute links, as before.
  const urlToRelFile = new Map()
  const setRelFile = (url, relFile) => {
    urlToRelFile.set(url, relFile)
    urlToRelFile.set(url.replace(/\/$/, ''), relFile)
    urlToRelFile.set(url.replace(/\/?$/, '/'), relFile)
  }
  if (seg != null) {
    for (const p of allPages) setRelFile(p.url, relFileForPage(p, byUrl, plan).relFile)
  }

  // sourceUrl -> the absolute route it redirects to, for every `redirect` orphan
  // in this version. A redirected page is NOT emitted, so an inbound link to it
  // would otherwise resolve to a file that no longer exists -- broken, and only a
  // WARNING (onBrokenLinks: 'warn'). The converter rewrites those links to the
  // target instead (html-to-mdx retargetRedirect), so navigation inside the site
  // goes straight there and the client redirect is left doing the job only it can:
  // keeping the old URL alive for bookmarks and links from outside the site.
  //
  // Built for UNVERSIONED components too (outside the `seg != null` guard above):
  // relative .mdx links are a versioned-instance concern, but a dead inbound link
  // is not.
  const redirectRetargets = new Map()
  for (const p of allPages) {
    const { rec } = relFileForPage(p, byUrl, plan)
    const route = rec && redirectRoute(ctx.dispositions, rec)
    if (route) redirectRetargets.set(p.url, route)
  }

  // Pass 1: read each page's golden ONCE (cached) and collect its partial-
  // boundary sentinel regions, then make the version-wide factoring decision.
  // Collection always spans the WHOLE version (not the --id subset) so a
  // single-page run makes the same decisions a full run would.
  const htmlByUrl = new Map()
  const readGoldenRaw = (p) => {
    if (!htmlByUrl.has(p.url)) htmlByUrl.set(p.url, fs.readFileSync(p.file, 'utf8'))
    return htmlByUrl.get(p.url)
  }
  const pagesOcc = allPages.map((p) => ({ url: p.url, occ: collectOccurrences(readGoldenRaw(p)) }))
  // Factored partials import from THIS version's own _partials/ (the site-relative
  // outDir), so a versioned copy never pulls current's content. Forward slashes:
  // the string is an `@site/...` import path, not a filesystem path.
  const baseDir = path.relative(opts.outRoot, outDir).split(path.sep).join('/')
  const { decisions, report } = decide(pagesOcc, baseDir)

  // Co-located image placement for this version, from the REFERENCE GRAPH: each
  // image lands in the `images/` folder of the deepest directory that contains
  // every page using it (see lib/image-placement.js for why its published URL
  // cannot answer this). Spans allPages, never the --id subset, so a
  // single-page run places images exactly where a full run would; pages dropped
  // by orphan triage are excluded, since nothing will reference their images.
  const imagePlacement = planImagePlacement(allPages.flatMap((p) => {
    const { rec, relFile } = relFileForPage(p, byUrl, plan)
    if (rec && isUnpublished(ctx.dispositions, rec)) return []
    const dir = path.posix.dirname(relFile.split(path.sep).join('/'))
    return imageUrlsIn(readGoldenRaw(p), p.url).map((url) => ({ url, dir: dir === '.' ? '' : dir }))
  }))

  // Full (non-scoped) run regenerates the whole version tree from scratch, so
  // stale files from a previous layout do not linger.
  if (!opts.dry && !opts.id) pruneGenerated(outDir)

  // Single-sourced example files (from extract-examples.js): content -> the file
  // to import. The converter content-matches a code block's text to one of these
  // and emits a raw-loader import instead of baking the fence. Scanned from the
  // co-located dir so the match is against exactly what will be imported.
  const exCfg = examplesConfig(component, opts.outRoot, outDir)
  const examples = loadExamples(exCfg.dir, exampleLookup)

  // Reverse-map single-sourced attributes (no-baking): which attrs each page's
  // source references, so a value is only ever matched on a page that uses it.
  const attrsByKey = scanPageAttrs(component, seg, opts.sourcesDir)

  // Snapshot-conditional splicing (see the block comment above condRegionRe).
  // Same page, other versions: slug -> seg -> golden file. Keyed by slug because
  // that is version-independent, and built from every version's golden because the
  // donor half lives in a version this pass is not converting.
  const goldenBySlug = new Map()
  for (const gp of allGoldenForComponent) {
    const s = urlToSlug(gp.url, component, gp.versionSeg)
    if (!goldenBySlug.has(s)) goldenBySlug.set(s, new Map())
    goldenBySlug.get(s).set(gp.versionSeg, gp.file)
  }
  // Donor order: the else-branch is kept by RELEASE renders (newest first, so the
  // content is the most current authored form); the then-branch only by the
  // snapshot render. Versions this component does not publish are not candidates.
  const releaseSegs = (VERSIONS[component] && VERSIONS[component].releases) || []
  const donorOrder = { ifndef: releaseSegs, ifdef: [currentSegFor(component)] }
  const spliced = []
  const spliceSkips = []
  const srcText = (ref, file) => {
    try {
      return execFileSync('git', ['-C', path.join(opts.sourcesDir, NAV_SOURCES[component].repo), 'show', `${ref}:${file}`], { encoding: 'utf8' })
    } catch { return null }
  }

  // Add whichever conditional branch this version's render did not keep, taken
  // from a version that kept it. No-op unless the page has exactly one branch.
  function withBothConditionalBranches (mdx, { page, rec, relFile, pageVars, proseVars, hrefVars, codeVars, codeValueVars }) {
    if (seg == null) return mdx // unversioned component: no cut, no other version
    const has = { ifdef: /<IfSnapshot>/.test(mdx), ifndef: /<IfNotSnapshot>/.test(mdx) }
    if (has.ifdef === has.ifndef) return mdx // neither, or already both
    const missing = has.ifdef ? 'ifndef' : 'ifdef'
    const srcPath = sourcePathFor(component, rec)
    const mine = srcPath && sourceBranchText(srcText(refFor(component, seg), srcPath), missing)
    if (!mine) return mdx // this version's source has no such branch: nothing to add

    const bySeg = goldenBySlug.get(urlToSlug(page.url, component, seg)) || new Map()
    for (const donor of donorOrder[missing] || []) {
      if (donor === seg || !bySeg.has(donor)) continue
      const theirs = sourceBranchText(srcText(refFor(component, donor), srcPath), missing)
      if (theirs !== mine) {
        spliceSkips.push({ url: page.url, donor, reason: 'source-differs' })
        continue
      }
      const regions = condRegions(fs.readFileSync(bySeg.get(donor), 'utf8'), missing)
      if (regions.length !== 1) {
        spliceSkips.push({ url: page.url, donor, reason: `donor has ${regions.length} regions` })
        continue
      }
      // Donor's variable maps (its values are what is baked in that render),
      // recipient's page URL (links must resolve where this page lives).
      const donorVer = { seg: donor, kind: donor === currentSegFor(component) ? 'current' : 'release' }
      const donorLookup = lookupFor(donorVer)
      const donorAttrs = scanPageAttrs(component, donor, opts.sourcesDir).get(keyOf(rec))
      const dPageVars = buildPageVars(donorAttrs && donorAttrs.all, donorLookup)
      const { body: fragment } = convertBody(regions[0], {
        pageUrl: page.url, relFile, component, seg, partials: new Map(), linkVars: ctx.linkVars, examples,
        pageVars: dPageVars,
        proseVars: proseVarsFor(dPageVars, (donorAttrs && donorAttrs.prose) || new Set(), markedAttrsFor(component)),
        ...(() => {
          const t = buildTemplates(component, [rec], donor, opts.sourcesDir, donorLookup)
          return {
            hrefVars: t.hrefs,
            codeVars: t.code,
            codeValueVars: codeValueVarsFor(dPageVars, t.named),
          }
        })(),
        latestVersions: ctx.latestVersions,
        urlToRelFile,
        redirectRetargets,
        imagePlacement,
      })
      if (!fragment.trim()) { spliceSkips.push({ url: page.url, donor, reason: 'empty' }); continue }
      spliced.push({ url: page.url, missing, donor })
      // Match the counterpart's INDENTATION. These regions are often inside a list
      // item or a <TabItem> (install.adoc's are), where Markdown reads a block at
      // column 0 as ending the item — so an unindented splice would silently move
      // the content out of the tab it belongs to.
      // Anchored to the whole LINE so the counterpart's own indent is captured and
      // reapplied to every line of the fragment, its opening tag included.
      // Keep the source order: then-branch first, else-branch second.
      const anchor = missing === 'ifndef' ? /^([ \t]*)<\/IfSnapshot>/m : /^([ \t]*)<IfNotSnapshot>/m
      const indentAll = (indent) => fragment.split('\n').map((l) => (l.trim() ? indent + l : l)).join('\n')
      return mdx.replace(anchor, (line, indent) => (missing === 'ifndef'
        ? `${indent}</IfSnapshot>\n\n${indentAll(indent)}`
        : `${indentAll(indent)}\n\n${indent}<IfNotSnapshot>`))
    }
    return mdx
  }

  let written = 0
  let dropped = 0
  const orphans = []
  const problems = []
  for (const p of pages) {
    // Stem/entry/relFile via the shared derivation (see relFileForPage), so the
    // emitted file matches the URL->file map used for relative-link resolution.
    const { key, stem, rec, entry, relFile } = relFileForPage(p, byUrl, plan)

    // A page an orphan triage decision withholds -- `drop-404` (dead or empty,
    // its URL may 404) or `redirect` (its URL is kept alive by a client
    // redirect instead). Emit nothing at all: for both, the decision only takes
    // effect if the file never reaches the site, and for `redirect` a real page
    // at the URL would win over the redirect.
    if (rec && isUnpublished(ctx.dispositions, rec)) { dropped++; continue }

    if (!entry) orphans.push(p.url)

    const html = readGoldenRaw(p)
    let title = rec && rec.title ? titleText(rec.title) : null
    let derived = false
    if (!title) { title = deriveTitle(html); derived = true }
    if (!title) { title = (stem || 'index').replace(/-/g, ' '); derived = true }

    const attrsHere = attrsByKey.get(key)
    const pageVars = buildPageVars(attrsHere && attrsHere.all, exampleLookup)
    const proseVars = proseVarsFor(pageVars, (attrsHere && attrsHere.prose) || new Set(), markedAttrsFor(component))
    const tpl = buildTemplates(component, [rec], seg, opts.sourcesDir, exampleLookup)
    // The example files this page's own source includes -- the tie-breaker when
    // several files hold identical content (see chooseExample).
    // `example$/foo.java` (the corpus writes the leading slash) resolves to a
    // coord whose relative keeps it; the co-located tree is keyed without.
    const pageExampleFiles = rec
      ? new Set(collectPageExamples(rec, seg, opts.sourcesDir).map((c) => String(c.relative).replace(/^\/+/, '')))
      : new Set()
    const hrefVars = tpl.hrefs
    const codeVars = tpl.code
    const codeValueVars = codeValueVarsFor(pageVars, tpl.named)

    let body, imports
    try {
      ({ body, imports } = convertBody(html, { pageUrl: p.url, relFile, component, seg, exampleImportBase: exCfg.importBase, partials: decisions, linkVars: ctx.linkVars, examples, pageExampleFiles, pageVars, proseVars, hrefVars, codeVars, codeValueVars, latestVersions: ctx.latestVersions, urlToRelFile, redirectRetargets, imagePlacement }))
      body = withBothConditionalBranches(body, { page: p, rec, relFile, pageVars, proseVars, hrefVars, codeVars, codeValueVars })
    } catch (err) {
      problems.push({ url: p.url, error: err.message })
      continue
    }

    const fm = frontmatter(title, {
      derived,
      // Slug is the authoritative URL preserver, derived from the page's real
      // URL (module segments and all) rather than the nav's stem-based guess.
      slug: urlToSlug(p.url, component, seg),
      sidebarLabel: entry ? entry.sidebarLabel : null,
      sidebarPosition: entry ? entry.sidebarPosition : null,
      // Orphan = in Antora but absent from the nav. A NAV-LESS component has no
      // nav to be absent from, and production sitemaps every one of its pages, so
      // the distinction does not apply there.
      unlisted: !entry && !isNavless(component),
      noSidebar: isNavless(component),
      badges: rec && rec.badges,
      cloud: rec && rec.cloud,
    })
    const importBlock = imports.size ? [...imports].join('\n') + '\n\n' : ''
    const mdx = fm + '\n\n' + importBlock + body + '\n'

    const outFile = path.join(outDir, relFile)
    if (opts.dry) {
      if (opts.verbose) console.log(`--- ${p.url} -> ${path.relative(process.cwd(), outFile)} ---\n${mdx}`)
    } else {
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, mdx)
    }
    written++
  }

  // Factored partials: convert each shared fragment ONCE into _partials/<slug>.mdx
  // (no frontmatter -- it is an imported fragment, not a route; the leading `_`
  // keeps Docusaurus from routing it).
  let partialsWritten = 0
  const partialProblems = []
  // A factored partial is converted ONCE, so it needs its own reverse-map — and
  // the right one is the UNION over the pages that include it. An attribute
  // reference inside an included file is resolved against the INCLUDING document's
  // attribute table (which is why MC's overview renders the shared JDK table as
  // "Platform 5.11.0" — MC's version, not Platform's), so a consumer page's
  // permitted set is exactly the right scope, and taking the union of consumers
  // keeps the source-scoping guard rather than widening to every attribute.
  // Without this the fragment got no vars at all and any reference inside it
  // baked: scanPageAttrs cannot see it either, since that records PAGE files in
  // the component's OWN repo and this one is a tagged include of an hz-docs page.
  const keyForUrl = (url) => { const rec = byUrl.get(url); return rec ? keyOf(rec) : null }
  // A partial's vars come from the UNION of its consuming pages: it is converted
  // once, on its own, so it has no page of its own to scope by. That includes the
  // exact template maps — without them a reference inside a partial bakes whenever
  // its value is one the reverse-map refuses (a same-value collision, a bare
  // number), which is what left getting-started-install-enterprise.mdx carrying two
  // literal `5.8.0-SNAPSHOT` docker/version lines.
  const partialVarsFor = (d) => {
    const { all, prose } = consumerAttrs(d.pages, keyForUrl, attrsByKey)
    const pageVars = buildPageVars(all, exampleLookup)
    const tpl = buildTemplates(component, (d.pages || []).map((u) => byUrl.get(u)), seg, opts.sourcesDir, exampleLookup)
    return {
      pageVars,
      proseVars: proseVarsFor(pageVars, prose, markedAttrsFor(component)),
      hrefVars: tpl.hrefs,
      codeVars: tpl.code,
      codeValueVars: codeValueVarsFor(pageVars, tpl.named),
    }
  }
  for (const [id, d] of decisions) {
    try {
      const { pageVars, proseVars, hrefVars, codeVars, codeValueVars } = partialVarsFor(d)
      // Resolve against a page that ACTUALLY INCLUDES this partial, not `pages[0]`
      // — the component's first page, which is what this used to pass. The golden
      // stores a partial's links as hrefs RELATIVE to the including page
      // (`dynamic-config#options`, `../maintain-cluster/restart-cluster`), so
      // resolving them against an unrelated page's depth silently produced URLs
      // one segment short: 5 dead links across 4 Platform pages, each pointing at
      // a plausible-looking route that does not exist.
      //
      // Any of the partial's own pages will do: factoring requires every
      // occurrence to render IDENTICAL inner HTML, and two including pages at
      // different depths would resolve the same xref to different relative hrefs
      // — so such a partial is declined as content-varies before it reaches here.
      const partialPageUrl = (d.pages && d.pages[0]) || pages[0].url
      const { body, imports } = convertBody(d.representative, { pageUrl: partialPageUrl, relFile: path.join('_partials', d.slug + '.mdx'), component, seg, partials: decisions, linkVars: ctx.linkVars, examples, pageVars, proseVars, hrefVars, codeVars, codeValueVars, latestVersions: ctx.latestVersions, urlToRelFile, redirectRetargets, imagePlacement })
      const importBlock = imports.size ? [...imports].join('\n') + '\n\n' : ''
      d.mdx = importBlock + body + '\n'
    } catch (err) {
      partialProblems.push({ id, error: err.message })
      continue
    }
    if (!opts.dry) {
      const f = path.join(outDir, '_partials', d.slug + '.mdx')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, d.mdx)
    }
    partialsWritten++
  }

  // Category descriptor files.
  let cats = 0
  if (!opts.dry && !opts.id) {
    for (const c of plan.categories) {
      const f = path.join(outDir, c.relFile)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify(c.content, null, 2) + '\n')
      cats++
    }
  }

  // Audit trail (internal, under build/), suffixed by version so versions of the
  // same component do not overwrite each other.
  writePartialsReport(opts, component, seg, report, new Set(pages.map((p) => p.url)))

  return { seg, kind, outDir, written, dropped, cats, partialsWritten, orphans, problems, partialProblems, spliced, spliceSkips, duplicates: plan.duplicates, imagePlacement }
}

// Per-version partials audit: what was factored, declined, or left inline
// (unmarked). The 100%-coverage cross-check against partials-registry.json is
// what catches an included fragment that produced no sentinel.
function writePartialsReport (opts, component, seg, report, pageUrls) {
  const factored = report.filter((r) => r.decision === 'factored')
  const declined = report.filter((r) => r.decision === 'declined')
  const reportIds = new Set(report.map((r) => r.id))
  const unmarked = []
  const regPath = path.join(opts.goldenDir, 'partials-registry.json')
  if (fs.existsSync(regPath)) {
    const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'))
    const byId = new Map()
    for (const row of registry.includes || []) {
      // The registry is corpus-wide: every component AND every version. This
      // report is one component-version, so scope by the pages this run actually
      // converted -- not by the id's component prefix, which counted a partial's
      // sites in EVERY version (an unmarked row read `occurrences: 48` next to
      // per-version factored rows) and reported ids that do not exist on this
      // branch at all as unmarked here (5.3 showed 11 unmarked, 5 of them
      // partials introduced in later versions).
      if (!pageUrls.has(row.page)) continue
      if (!byId.has(row.id)) byId.set(row.id, { id: row.id, family: row.family, pages: [] })
      byId.get(row.id).pages.push(row.page)
    }
    for (const [id, info] of byId) {
      if (reportIds.has(id)) continue
      unmarked.push({ id, family: info.family, occurrences: info.pages.length, pages: info.pages.sort(), decision: 'unmarked', reason: 'inlined (no liftable block — e.g. list-continuation fusion or mid-paragraph splice)' })
    }
    unmarked.sort((a, b) => a.id.localeCompare(b.id))
  }
  if (!opts.dry && (report.length || unmarked.length)) {
    const reportDir = path.dirname(opts.goldenDir)
    const suffix = seg ? `-${seg}` : ''
    fs.mkdirSync(reportDir, { recursive: true })
    fs.writeFileSync(path.join(reportDir, `partials-report-${component}${suffix}.json`),
      JSON.stringify({
        component,
        version: seg || null,
        counts: { total: report.length + unmarked.length, factored: factored.length, declined: declined.length, unmarked: unmarked.length },
        partials: [...report, ...unmarked],
      }, null, 2) + '\n')
  }
  return { factored, declined, unmarked }
}

// `build/image-placement.json`: image URL -> repo-relative destination file, the
// handover to extract-images.js. The converter is the producer because placement
// follows the reference graph and each page's output file, both of which only
// exist here; extract-images is a pure consumer that writes bytes where this
// says. That replaces the previous design, where the same URL-rewriting rule was
// written out by hand in both files and had to be kept in lockstep.
//
// MERGED, not overwritten, and scoped to the segments this run actually
// regenerated — for the same reason `--releases` must not shrink versions.json:
// a subset run leaves the other versions' trees (and their images) on disk and
// live, so their placements must survive it.
function writeImagePlacement (opts, results) {
  if (opts.dry) return null
  const file = path.join(path.dirname(opts.goldenDir), 'image-placement.json')
  let placements = {}
  try {
    placements = JSON.parse(fs.readFileSync(file, 'utf8')).placements || {}
  } catch { /* first run — start empty */ }

  const prefixes = results.map((r) => `/${opts.component}/` + (r.seg ? r.seg + '/' : ''))
  for (const url of Object.keys(placements)) {
    if (prefixes.some((pre) => url.startsWith(pre))) delete placements[url]
  }
  for (const r of results) {
    const treeRel = path.relative(opts.outRoot, r.outDir).split(path.sep).join('/')
    for (const [url, dest] of r.imagePlacement) placements[url] = path.posix.join(treeRel, dest)
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sorted = Object.fromEntries(Object.keys(placements).sort().map((k) => [k, placements[k]]))
  fs.writeFileSync(file, JSON.stringify({ generatedBy: 'converter/convert.js', placements: sorted }, null, 2) + '\n')
  return { file, count: Object.keys(sorted).length }
}

// `<component>_versions.json`: the ordered release list (newest first) that a
// versioned Docusaurus instance reads. It is the ONLY per-version file the
// converter writes — the site derives the version paths, the dropdown default and
// the per-release `<component>_versioned_sidebars/` stubs from it (see
// src/docsPlugins.ts), so those stay out of the converter and out of git.
function writeVersionsFile (opts, component, releases) {
  if (opts.dry) return
  const versionsFile = path.join(opts.outRoot, `${component}_versions.json`)
  fs.writeFileSync(versionsFile, JSON.stringify(releases, null, 2) + '\n')
}

function main () {
  const opts = parseArgs(process.argv)
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))
  const { flat, flatComponents, linkValueToName, versioned } = collectVariables(manifest)
  const linkVars = linkValueToName.get(opts.component) || new Map()

  const allGoldenForComponent = goldenPages(opts.goldenDir).filter((p) => p.component === opts.component)
  if (allGoldenForComponent.length === 0) {
    console.error(`[convert] no golden pages for component=${opts.component}`)
    process.exit(1)
  }

  // Guard the `--releases` subset selector against the canonical set so a typo
  // ('5.6' for '5.16') can't quietly produce an off-target run, and so it is
  // explicit that skipped versions are preserved, not de-listed (see below).
  if (opts.releases && isVersioned(opts.component)) {
    const canonical = VERSIONS[opts.component].releases
    const unknown = opts.releases.filter((r) => !canonical.includes(r))
    if (unknown.length) {
      console.error(`[convert] --releases has version(s) not in lib/layout.js VERSIONS.${opts.component}: ${unknown.join(', ')}`)
      console.error(`[convert] known releases: ${canonical.join(', ')}. To add a version, edit VERSIONS first.`)
      process.exit(1)
    }
    const skipped = canonical.filter((r) => !opts.releases.includes(r))
    if (skipped.length) console.warn(`[convert] --releases subset: regenerating ${opts.releases.join(', ')}; preserving (not regenerating) ${skipped.join(', ')}`)
  }

  const versions = versionsToProcess(opts.component, opts.releases)
  // component -> its current (stable) latest version, for floating versionless
  // cross-component xrefs to `/<comp>/latest/` instead of a baked number.
  const latestVersions = {}
  for (const c of manifest.components || []) if (c.latestVersion) latestVersions[c.name] = c.latestVersion
  // Orphan triage decisions (orphancheck/allowlist.json) drive three conversion
  // behaviours: drop-404 and redirect pages are not emitted, a redirect also
  // contributes a {from,to} to src/redirects.ts, and keep-in-nav pages are
  // injected into the nav. Loaded once per run and passed through ctx.
  const dispositions = loadDispositions()
  const ctx = { component: opts.component, manifest, allGoldenForComponent, linkVars, flat, versioned, opts, latestVersions, dispositions }

  const results = []
  for (const ver of versions) {
    const r = convertVersion(ver, ctx)
    if (r) results.push(r)
  }
  if (results.length === 0) {
    console.error(`[convert] nothing converted for component=${opts.component}${opts.id ? ' id=' + opts.id : ''}`)
    process.exit(1)
  }

  // The versions.json release list and the component's live routes must reflect
  // the component's CANONICAL release set (lib/layout.js VERSIONS), NOT just what
  // this run emitted. `--releases` is a
  // "regenerate only these versions this run" selector for speed; it must never
  // shrink versions.json / redirects to that subset and silently de-list the
  // versions it skipped (their docs trees are still on disk and still live).
  const canonicalReleases = (VERSIONS[opts.component] && VERSIONS[opts.component].releases) || []
  if (isVersioned(opts.component)) writeVersionsFile(opts, opts.component, canonicalReleases)

  const placed = writeImagePlacement(opts, results)
  if (placed) console.log(`[convert] image placement -> ${placed.file} (${placed.count} image(s) site-wide)`)

  // Site-wide generated files, written once with full manifest context so a
  // per-component run keeps the other components' entries intact.
  if (!opts.dry && (flat.size || versioned.size)) {
    writeVariablesFile(opts.variablesFile, groupVariablesBySource(flat, flatComponents, opts), versioned)
  }
  const liveSegsByComponent = new Map()
  for (const comp of Object.keys(NAV_SOURCES)) {
    liveSegsByComponent.set(comp, null) // default: unversioned (no gate)
  }
  for (const comp of Object.keys(VERSIONS)) {
    // A versioned component's live routes = current + its canonical releases
    // (all live versions), independent of which subset this run regenerated.
    liveSegsByComponent.set(comp, new Set([currentSegFor(comp), ...(VERSIONS[comp].releases || [])]))
  }
  const redirects = collectRedirects(manifest, liveSegsByComponent, ctx.dispositions)
  if (!opts.dry) writeRedirectsFile(opts.redirectsFile, redirects)

  // --- reporting -----------------------------------------------------------
  let hardFail = false
  for (const r of results) {
    const where = path.relative(process.cwd(), r.outDir)
    const tag = r.seg ? `${opts.component}@${r.seg}` : opts.component
    console.log(`[convert] ${tag}: ${r.written} page(s)` +
      (opts.dry ? ' converted (dry-run)' : ` + ${r.cats} categor${r.cats === 1 ? 'y' : 'ies'} + ${r.partialsWritten} partial(s) -> ${where}`))
    if (r.duplicates.length) console.log(`   nav duplicates (kept first): ${[...new Set(r.duplicates)].join(', ')}`)
    // Conditional branches taken from another version's render, and the ones
    // refused. Reported rather than silent: a skip means that version's page
    // carries only one half of a snapshot conditional, so a cut from it (or, for a
    // release, the page itself) is missing content.
    if (r.spliced.length) {
      console.log(`   ${r.spliced.length} conditional branch(es) added from another version:`)
      for (const s of r.spliced) console.log(`     + ${s.missing === 'ifndef' ? '<IfNotSnapshot>' : '<IfSnapshot>'} from @${s.donor}  ${s.url}`)
    }
    if (r.spliceSkips.length) {
      console.log(`   ${r.spliceSkips.length} conditional branch(es) NOT added (that half stays absent):`)
      for (const s of r.spliceSkips) console.log(`     - ${s.url} from @${s.donor}: ${s.reason}`)
    }
    if (r.orphans.length) console.log(`   ${r.orphans.length} page(s) NOT in nav (placed flat): ${r.orphans.map((u) => u.replace(/\/$/, '').split('/').pop()).join(', ')}`)
    if (r.partialProblems.length) {
      hardFail = true
      console.log(`   ${r.partialProblems.length} partial(s) failed to convert:`)
      for (const pr of r.partialProblems) console.log(`     ✗ ${pr.id}: ${pr.error}`)
    }
    if (r.problems.length) {
      hardFail = true
      console.log(`   ${r.problems.length} page(s) failed:`)
      for (const pr of r.problems) console.log(`     ✗ ${pr.url}: ${pr.error}`)
    }
  }
  if (!opts.dry) console.log(`[convert] ${redirects.length} client redirect(s) -> ${path.relative(process.cwd(), opts.redirectsFile)}`)
  if (hardFail) process.exit(1)
}

main()
