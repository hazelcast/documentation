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
// (see buildHrefVars); shared with the selftest so the grammar has one definition.
const { attrHrefTemplates } = require('./lib/links')
const { parseNav, buildPlan, injectNavEntries, pageKey } = require('./lib/nav')
const { loadDispositions, isDropped, navInjectionsFor } = require('../lib/dispositions')
// Single-sources "which contexts render into flow text" with the marking pass, so
// prose reverse-mapping and marking can never disagree — see scanPageAttrs.
const { wrappableRefs } = require('../antora-extension/mark-attributes')
// Shared with the build-time example-attributes loader so the match key the
// converter computes reproduces exactly what the loader renders (no drift).
const substitute = require('../../plugins/lib/substitute-attributes')
// The marking pass's branch grammar, reused so the converter's idea of an
// `ifdef`/`ifndef` snapshot branch cannot drift from the marker's.
const { branchesAt } = require('../antora-extension/mark-conditionals')
// Layout/source config shared with the reference checker (refcheck/run.js) so
// the two resolve source branches and output paths identically (no drift):
// which mirror + branch each component reads (NAV_SOURCES), which versions are
// emitted (VERSIONS / currentSegFor), and the version/path helpers.
const {
  NAV_SOURCES, currentSegFor, VERSIONS, markedAttrsFor,
  isVersioned, refFor, versionsToProcess, outDirFor, urlToSlug,
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

// page-aliases -> Docusaurus client redirects. Every alias resource in the
// manifest records the OLD (aliased) URL plus `aliasTo`, the current page it
// redirects to (see emit-manifest). We emit one {from, to} per alias for the
// converted components only — the client-redirects plugin fails the build if a
// `to` is not a real route, and an alias always targets a page in its own
// component, so gating on the components the converter lays out (NAV_SOURCES)
// guarantees the `to` component is built. For a VERSIONED component we further
// gate on `liveSegs`: only versions actually built this run are real routes
// (frozen versions are served elsewhere). Spans all converted components so any
// run regenerates the complete src/redirects.ts, like variables.ts.
function collectRedirects (manifest, liveSegsByComponent) {
  const converted = new Set(Object.keys(NAV_SOURCES))
  const redirects = []
  for (const r of manifest.resources || []) {
    if (r.family !== 'alias' || !r.aliasTo || !converted.has(r.component)) continue
    const liveSegs = liveSegsByComponent.get(r.component)
    // liveSegs === null => unversioned component (no gate); a Set => versioned,
    // keep only aliases whose target version is one we built.
    if (liveSegs && !liveSegs.has(r.version)) continue
    const from = normalizeRoute(r.url)
    const to = normalizeRoute(r.aliasTo)
    if (from === to) continue
    redirects.push({ from, to })
  }
  redirects.sort((a, b) => a.from.localeCompare(b.from))
  return redirects
}

function writeRedirectsFile (file, redirects) {
  const body = redirects
    .map((r) => `  { from: ${JSON.stringify(r.from)}, to: ${JSON.stringify(r.to)} },`)
    .join('\n')
  const out = '// Generated by migration/converter — do not edit by hand.\n' +
    '// page-aliases → client redirects (old Antora URL → current page), consumed\n' +
    '// by @docusaurus/plugin-client-redirects in docusaurus.config.ts.\n' +
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
    if (r.title) titleByKey.set(keyOf(r), r.title)
  }
  return { byUrl, titleByKey }
}

// A page resource's plan key. Derived from the manifest record's own module +
// relative path (NOT from its URL), so it is exactly the coordinate the nav writes.
const keyOf = (r) => pageKey(r.module, String(r.relative || '').replace(/\.adoc$/, ''))

// Co-located example files -> a content-addressed index for the converter:
// canonical file content -> { file, conums }. The converter matches a golden
// code block's text against this to decide whether to import the file
// (single-sourced) instead of baking a fence. Empty when the component has no
// examples or extract-examples has not run.
//
// The co-located files are BYTE-FAITHFUL (Antora {attribute} placeholders and
// native `<N>` conum markers intact), but the golden shows Antora's resolved
// value and renders conums as `(N)`. So the match key reproduces the golden:
// substitute attributes with this version's values (`lookup`), then rewrite a
// trailing `<N>` conum marker to `(N)`. `conums` records whether the raw file
// carries markers, so the emitted <CodeBlock> gets the `conums` metastring.
function loadExamples (examplesDir, lookup) {
  const byContent = new Map()
  if (!fs.existsSync(examplesDir)) return byContent
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      const raw = fs.readFileSync(p, 'utf8')
      const rel = path.relative(examplesDir, p).split(path.sep).join('/')
      byContent.set(exampleKey(raw, lookup), { file: rel, conums: CONUM_LINE.test(raw) })
    }
  }
  walk(examplesDir)
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

function loadNavAdoc (component, seg, sourcesDir) {
  const src = NAV_SOURCES[component]
  if (!src) return null
  const ref = src.refFor ? src.refFor(seg) : src.ref
  const repoDir = path.join(sourcesDir, src.repo)
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${src.file}`], { encoding: 'utf8' })
  } catch (err) {
    console.warn(`[convert] could not read nav.adoc for ${component}@${seg || '-'} (${err.message.split('\n')[0]}); falling back to flat layout`)
    return null
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
function buildPageVars (names, lookup) {
  const m = new Map()
  if (!names) return m
  for (const name of names) {
    const v = lookup[name]
    if (v != null && v !== '') m.set(String(v), name)
  }
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
function buildHrefVars (attrsHere, lookup) {
  const m = new Map()
  if (!attrsHere || !attrsHere.hrefs) return m
  for (const tpl of attrsHere.hrefs) {
    const names = [...tpl.matchAll(/\{([A-Za-z0-9_][A-Za-z0-9_-]*)\}/g)].map((x) => x[1])
    if (!names.length || !names.every((n) => attrsHere.all.has(n))) continue
    const resolved = substitute(tpl, lookup)
    if (resolved !== tpl) m.set(resolved, tpl)
  }
  return m
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

function frontmatter (title, { derived, slug, sidebarLabel, sidebarPosition, unlisted, badges, cloud } = {}) {
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
  if (derived) lines.push('hide_title: true')
  lines.push('---')
  return lines.join('\n')
}

const yaml = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function deriveTitle (html) {
  const m = html.match(/<h[1-6][^>]*>(?:<a[^>]*><\/a>)?([\s\S]*?)<\/h[1-6]>/i)
  if (!m) return null
  return m[1].replace(/<[^>]+>/g, '').replace(/&#8217;|&#x2019;/g, "'").replace(/\s+/g, ' ').trim()
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
  const injections = navInjectionsFor(ctx.dispositions, component).filter((i) => titleByKey.has(i.key))
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
  if (seg != null) {
    for (const p of allPages) {
      const { relFile } = relFileForPage(p, byUrl, plan)
      urlToRelFile.set(p.url, relFile)
      urlToRelFile.set(p.url.replace(/\/$/, ''), relFile)
      urlToRelFile.set(p.url.replace(/\/?$/, '/'), relFile)
    }
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

  // Full (non-scoped) run regenerates the whole version tree from scratch, so
  // stale files from a previous layout do not linger.
  if (!opts.dry && !opts.id) pruneGenerated(outDir)

  // Single-sourced example files (from extract-examples.js): content -> the file
  // to import. The converter content-matches a code block's text to one of these
  // and emits a raw-loader import instead of baking the fence. Scanned from the
  // co-located dir so the match is against exactly what will be imported.
  const examples = loadExamples(path.join(outDir, 'examples'), exampleLookup)

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
  function withBothConditionalBranches (mdx, { page, rec, relFile, pageVars, proseVars, hrefVars }) {
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
        hrefVars: buildHrefVars(donorAttrs, donorLookup),
        latestVersions: ctx.latestVersions,
        urlToRelFile,
      })
      if (!fragment.trim()) { spliceSkips.push({ url: page.url, donor, reason: 'empty' }); continue }
      spliced.push({ url: page.url, missing, donor })
      // Keep the source order: then-branch first, else-branch second.
      return missing === 'ifndef'
        ? mdx.replace('</IfSnapshot>', `</IfSnapshot>\n\n${fragment}`)
        : mdx.replace('<IfNotSnapshot>', `${fragment}\n\n<IfNotSnapshot>`)
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

    // A `drop-404` orphan is a page a human decided not to carry over (dead or
    // empty, nothing links to it, its URL may 404). Emit nothing at all: the
    // decision only takes effect if the file never reaches the site.
    if (rec && isDropped(ctx.dispositions, rec)) { dropped++; continue }

    if (!entry) orphans.push(p.url)

    const html = readGoldenRaw(p)
    let title = rec && rec.title
    let derived = false
    if (!title) { title = deriveTitle(html); derived = true }
    if (!title) { title = (stem || 'index').replace(/-/g, ' '); derived = true }

    const attrsHere = attrsByKey.get(key)
    const pageVars = buildPageVars(attrsHere && attrsHere.all, exampleLookup)
    const proseVars = proseVarsFor(pageVars, (attrsHere && attrsHere.prose) || new Set(), markedAttrsFor(component))
    const hrefVars = buildHrefVars(attrsHere, exampleLookup)

    let body, imports
    try {
      ({ body, imports } = convertBody(html, { pageUrl: p.url, relFile, component, seg, partials: decisions, linkVars: ctx.linkVars, examples, pageVars, proseVars, hrefVars, latestVersions: ctx.latestVersions, urlToRelFile }))
      body = withBothConditionalBranches(body, { page: p, rec, relFile, pageVars, proseVars, hrefVars })
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
      unlisted: !entry, // orphan (not in nav)
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
  const partialVarsFor = (d) => {
    const { all, prose } = consumerAttrs(d.pages, keyForUrl, attrsByKey)
    const pageVars = buildPageVars(all, exampleLookup)
    return { pageVars, proseVars: proseVarsFor(pageVars, prose, markedAttrsFor(component)) }
  }
  for (const [id, d] of decisions) {
    try {
      const { pageVars, proseVars } = partialVarsFor(d)
      const { body, imports } = convertBody(d.representative, { pageUrl: pages[0].url, relFile: path.join('_partials', d.slug + '.mdx'), component, seg, partials: decisions, linkVars: ctx.linkVars, examples, pageVars, proseVars, latestVersions: ctx.latestVersions, urlToRelFile })
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
  writePartialsReport(opts, component, seg, report, decisions)

  return { seg, kind, outDir, written, dropped, cats, partialsWritten, orphans, problems, partialProblems, spliced, spliceSkips, duplicates: plan.duplicates }
}

// Per-version partials audit: what was factored, declined, or left inline
// (unmarked). The 100%-coverage cross-check against partials-registry.json is
// what catches an included fragment that produced no sentinel.
function writePartialsReport (opts, component, seg, report, decisions) {
  const factored = report.filter((r) => r.decision === 'factored')
  const declined = report.filter((r) => r.decision === 'declined')
  const reportIds = new Set(report.map((r) => r.id))
  const unmarked = []
  const regPath = path.join(opts.goldenDir, 'partials-registry.json')
  if (fs.existsSync(regPath)) {
    const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'))
    const byId = new Map()
    for (const row of registry.includes || []) {
      if (!row.id.startsWith(component + ':')) continue
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
  // Orphan triage decisions (orphancheck/allowlist.json) drive two conversion
  // behaviours: drop-404 pages are not emitted, keep-in-nav pages are injected
  // into the nav. Loaded once per run and passed through ctx.
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
  const redirects = collectRedirects(manifest, liveSegsByComponent)
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
  if (!opts.dry) console.log(`[convert] ${redirects.length} page-alias redirect(s) -> ${path.relative(process.cwd(), opts.redirectsFile)}`)
  if (hardFail) process.exit(1)
}

main()
