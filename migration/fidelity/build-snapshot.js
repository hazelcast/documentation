'use strict'

// Golden-snapshot builder. Renders the Antora main-content HTML for every
// migrated page at the PINNED BASELINE -- the SHAs recorded in the lockfile,
// NOT live upstream -- and writes it to a gitignored tree under build/golden/,
// keyed to that pin. This is the "before" image every fidelity layer diffs
// against. It is the expensive step (full document conversion, which the index
// pass deliberately skips), so it is built deliberately and cached, never
// re-run on every fidelity check. Regenerate with `npm run fidelity:snapshot`.
//
//   node fidelity/build-snapshot.js [path/to/playbook.yml] [--out DIR] [--lockfile FILE]
//
// It reuses the index-pass playbook so sources and pins are identical to
// manifest.json. Each page is rendered with its own component-version AsciiDoc
// config, so per-version conditionals (e.g. ifdef::snapshot on the
// 5.8-snapshot prerelease) resolve exactly as they do in production. Output is
// embeddable body HTML (the main content), so there is no site chrome to strip.
//
// LIMITATION: extensions registered only in the production hazelcast-docs
// playbook are not loaded here (notably the swagger-ui block macro). The 6
// Swagger pages are a separate fidelity category and are expected to render
// imperfectly in this snapshot.

const fs = require('node:fs')
const path = require('node:path')

const buildPlaybook = require('@antora/playbook-builder')
const aggregateContent = require('@antora/content-aggregator')
const classifyContent = require('@antora/content-classifier')
const { loadAsciiDoc, resolveAsciiDocConfig } = require('@antora/asciidoc-loader')
const { configureLogger, finalizeLogger } = require('@antora/logger')

const { buildLockfile } = require('../antora-extension/emit-manifest')
const { registerPageAliases } = require('../antora-extension/register-page-aliases')
const { createPartialMarker } = require('../antora-extension/mark-partials')
const { wrapRefs, spanify, hasSentinelResidue } = require('../antora-extension/mark-attributes')
const { wrapConditionals } = require('../antora-extension/mark-conditionals')
const { literalizeMonospace } = require('../antora-extension/normalize-monospace')
const { poisonAttributes, preResolveTargets } = require('../antora-extension/poison-attributes')
const { markedAttrsFor } = require('../lib/layout')
const { lockfileKey, lockfileKeyFromFile } = require('./lockfile-key')

// Components we actually migrate (convert + emit to the golden tree). Everything
// else in the build (imdg, tutorials + its 56 guide repos, ...) is
// resolution-only: kept in the catalog + manifest so cross-component xrefs
// resolve as production does, but never emitted here. An allowlist is used (not
// a denylist) so any resolution-only component is excluded regardless of the
// component name its repo declares.
const MIGRATED = new Set([
  'hazelcast', 'management-center', 'clc', 'operator', 'cloud', 'jdbc-driver', 'home', 'privacy',
])

function parseArgs (argv) {
  const args = argv.slice(2)
  const flagValueIdxs = new Set()
  for (const flag of ['--out', '--lockfile', '--component']) {
    const i = args.indexOf(flag)
    if (i !== -1) flagValueIdxs.add(i + 1)
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagValueIdxs.has(i))
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  // CENSUS mode: render the same corpus with every CONTENT attribute replaced by
  // a unique inert token (antora-extension/poison-attributes.js), so the output
  // records exactly where each attribute flowed. Feeds the no-baking gate
  // (refcheck), never fidelity: it is a throwaway render written to its own tree,
  // with all three mark-* instrumentations off so it is directly comparable to
  // readGolden()'s de-instrumented golden. Monospace normalization stays ON --
  // it CHANGES the render, so the census must carry it to match.
  const census = args.includes('--census')
  return {
    census,
    playbookFile: path.resolve(positional[0] || 'antora/index-playbook.yml'),
    outDir: path.resolve(valueOf('--out', census ? 'build/census' : 'build/golden')),
    lockfileFile: path.resolve(valueOf('--lockfile', 'build/manifest/lockfile.json')),
    // Optional: render only this one component (e.g. --component cloud). The
    // full playbook still aggregates, so the pin check stays valid; only the
    // render/write step is scoped. Handy for a fast smoke test.
    component: valueOf('--component', null),
    // Instrument the golden with partial-boundary sentinels (see
    // antora-extension/mark-partials.js) so the converter can factor MDX
    // partials. ON by default: the sentinels are HTML comments, invisible to
    // Layer-1 canonicalize and stripped by readGolden() before any golden read,
    // so the instrumented golden is byte-equivalent to the bare render (proven
    // in the partials step-2 validation). --no-mark-partials renders bare.
    markPartials: !census && !args.includes('--no-mark-partials'),
    // Instrument the golden with attribute-reference marker spans (see
    // antora-extension/mark-attributes.js) so the converter can turn a marked
    // attribute back into a <Variable> instead of baking its value. ON by
    // default; the spans strip byte-for-byte in readGolden(), so the golden is
    // byte-equivalent to the bare render. --no-mark-attributes renders bare.
    markAttributes: !census && !args.includes('--no-mark-attributes'),
    // Instrument `ifdef::snapshot[]` blocks with passthrough comment sentinels
    // (see antora-extension/mark-conditionals.js) so the converter can wrap
    // snapshot-only content in <IfSnapshot> (current tree only) instead of
    // baking it per-version. ON by default; the sentinels sit inside the
    // conditional (so they gate with it) and strip byte-for-byte in readGolden().
    // --no-mark-conditionals renders bare.
    markConditionals: !census && !args.includes('--no-mark-conditionals'),
    // Backslash-escape emphasis chars inside inline monospace so Asciidoctor
    // renders `__trace` / `_` literally instead of mis-parsing the underscores as
    // emphasis (see antora-extension/normalize-monospace.js). Unlike the mark-*
    // passes this CHANGES the golden (deliberately: it fixes Antora's mangled
    // render); it is output-neutral where the emphasis was not firing, so a
    // component with no mis-parsed monospace stays byte-identical. ON by default;
    // --no-normalize-monospace renders bare.
    normalizeMonospace: !args.includes('--no-normalize-monospace'),
  }
}

// version@component -> that component version's resolved AsciiDoc config, so
// each page renders with its own attributes/conditionals. Mirrors what
// @antora/document-converter does internally.
function asciidocConfigsByVersion (contentCatalog, siteConfig) {
  const map = new Map()
  for (const component of contentCatalog.getComponents()) {
    for (const v of component.versions) {
      map.set(`${v.version}@${component.name}`, v.asciidoc || siteConfig)
    }
  }
  return map
}

// Parse the ndjson render log, keep error-level entries, and group them into a
// ranked inventory by error class (e.g. "target of include not found") so a
// flood of thousands of lines becomes a short, legible summary.
const ERROR_LEVELS = new Set(['error', 'fatal'])
function summarizeErrors (logPath, outDir) {
  let lines
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const groups = new Map()
  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const lvl = e && e.level
    if (!(ERROR_LEVELS.has(lvl) || (typeof lvl === 'number' && lvl >= 50))) continue
    const msg = e.msg || ''
    let cls = msg.slice(0, 80)
    let target = ''
    let m
    if ((m = msg.match(/^target of (include|xref|link) not found: (.+)$/))) {
      cls = `target of ${m[1]} not found`
      target = m[2]
    } else if ((m = msg.match(/^(skipping reference to missing attribute): (.+)$/))) {
      cls = m[1]
      target = m[2]
    }
    if (!groups.has(cls)) groups.set(cls, { class: cls, count: 0, targets: new Set(), files: new Set() })
    const g = groups.get(cls)
    g.count++
    if (target) g.targets.add(target)
    if (e.file && e.file.path) g.files.add(e.file.path)
  }
  const report = [...groups.values()]
    .map((g) => ({
      class: g.class,
      count: g.count,
      distinctTargets: g.targets.size,
      sampleTargets: [...g.targets].slice(0, 10),
      sampleFiles: [...g.files].slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count)
  fs.writeFileSync(path.join(outDir, 'render-errors.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

// Replicate the ONE UI template injection that adds body CONTENT (not chrome):
// hazelcast-docs-ui `article.hbs` renders, when a page sets
// `:page-include-tutorial-list:`, a <ul> of links to every `tutorials`-component
// page tagged for the product (`get-tutorial-pages` helper: page-layout=tutorial
// && page-product=<product>). Our snapshot converts AsciiDoc bodies only and
// never runs the UI templates, so without this the golden -- and therefore the
// converted MDX -- is missing that list (a faithfulness gap, not a converter
// bug). article.hbs hardcodes the 'cloud' product, so we do too. Appending the
// <ul> to the rendered body is enough: the converter turns it into a Markdown
// list, so golden and converted stay consistent AND the real links are restored.
function htmlEscape (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function tutorialListHtml (contentCatalog, product) {
  const items = []
  for (const p of contentCatalog.findBy({ component: 'tutorials', family: 'page' })) {
    const a = (p.asciidoc && p.asciidoc.attributes) || {}
    if (a['page-layout'] !== 'tutorial' || a['page-product'] !== product) continue
    const title = (p.asciidoc && p.asciidoc.doctitle) || a.doctitle || p.pub.url
    // Asciidoctor ulist shape (<li><p>...</p></li>), so the golden looks like any
    // other list to both the converter and the fidelity canonicalizer.
    items.push(`<li>\n<p><a href="${htmlEscape(p.pub.url)}">${htmlEscape(title)}</a></p>\n</li>`)
  }
  if (!items.length) return ''
  return `\n<div class="ulist">\n<ul>\n${items.join('\n')}\n</ul>\n</div>\n`
}

async function main () {
  const { census, playbookFile, outDir, lockfileFile, component, markPartials, markAttributes, markConditionals, normalizeMonospace } = parseArgs(process.argv)
  // Which components this run renders. Shared by the census poisoning pass and
  // the page filter so they cannot disagree: poisoning a component we do not
  // render would leak a foreign token into an in-scope page through a
  // cross-component xref label (whose text comes from the TARGET's title).
  const inScope = (name) => (component ? name === component : MIGRATED.has(name))

  // The canonical golden now carries partial sentinels by default; every golden
  // read routes through readGolden() (lib/pairing.js), which strips them, so the
  // baseline/anchor/inventory caches and Layer-1 diffs never see them.
  const playbook = buildPlaybook(['--playbook', playbookFile], {})
  // Send Antora/asciidoctor log messages (xref/include-not-found errors, etc.)
  // to a file instead of flooding the console, so they can be grouped into a
  // legible inventory after the run (see summarizeErrors).
  fs.mkdirSync(outDir, { recursive: true })
  const logPath = path.join(outDir, 'render-log.ndjson')
  configureLogger({
    ...playbook.runtime.log,
    destination: { ...(playbook.runtime.log && playbook.runtime.log.destination), file: logPath, append: false },
  })

  const siteConfig = resolveAsciiDocConfig(playbook)
  console.log(`[snapshot] aggregating content from ${playbookFile} ...`)
  const aggregate = await aggregateContent(playbook)
  console.log(`[snapshot] classifying ${aggregate.length} component-version bundles ...`)
  const contentCatalog = classifyContent(playbook, aggregate, siteConfig)

  // The pin is defined by lockfile.json. The snapshot MUST be built from that
  // exact pin, or every later diff compares against the wrong "before". Verify
  // it BEFORE spending time rendering, and hard-fail on any mismatch (a drifted
  // local clone). This is an internal-consistency check against our own
  // committed lockfile -- it never consults origin and never chases upstream.
  const renderedKey = lockfileKey(buildLockfile(contentCatalog))
  let committedKey = null
  try {
    committedKey = lockfileKeyFromFile(lockfileFile)
  } catch { /* no committed lockfile yet -- this snapshot defines the pin */ }
  if (committedKey && committedKey !== renderedKey) {
    console.error(
      `[snapshot] ABORT: local clones do not match the committed pin (${lockfileFile}).\n` +
        '           Reconcile them (re-fetch + re-run the index pass, or reset the clones)\n' +
        '           so the snapshot and manifest share a pin, then rebuild.'
    )
    process.exit(1)
  }

  // Register page aliases BEFORE rendering so xrefs to renamed/moved pages
  // resolve exactly as production does (the site generator does this; classify
  // alone does not). Without it the golden snapshot renders those links broken.
  const aliases = registerPageAliases(contentCatalog, siteConfig)
  console.log(`[snapshot] registered ${aliases.registered} page aliases` +
    (aliases.problems.length ? ` (${aliases.problems.length} skipped)` : ''))

  // Census poisoning: swap every content attribute's value for a unique token
  // BEFORE the per-version configs are read, so each page renders with the
  // poisoned table its own component-version owns. Reserved (machinery) names,
  // flags and empty values are left alone -- see poison-attributes.js.
  const censusEntries = []
  const censusSkipped = []
  if (census) {
    // FIRST, with the real values still in place: resolve attribute references out
    // of xref/include TARGETS, which must name real component versions to resolve
    // at all (see preResolveTargets).
    let coords = 0
    const attrsOf = new Map()
    for (const comp of contentCatalog.getComponents()) {
      for (const v of comp.versions) attrsOf.set(`${v.version}@${comp.name}`, (v.asciidoc && v.asciidoc.attributes) || {})
    }
    for (const file of contentCatalog.getFiles()) {
      const src = file.src || {}
      if ((src.family !== 'page' && src.family !== 'partial') || !file.contents || !inScope(src.component)) continue
      const { text, resolved } = preResolveTargets(file.contents.toString(), attrsOf.get(`${src.version}@${src.component}`) || {})
      if (resolved) { file.contents = Buffer.from(text); coords += resolved }
    }
    if (coords) console.log(`[census] pre-resolved ${coords} attribute reference(s) in xref/include targets`)

    let seq = 0
    for (const comp of contentCatalog.getComponents()) {
      if (!inScope(comp.name)) continue
      for (const v of comp.versions) {
        const attrs = v.asciidoc && v.asciidoc.attributes
        if (!attrs) continue
        const { entries, skipped } = poisonAttributes(attrs, () => ++seq)
        for (const e of entries) censusEntries.push({ component: comp.name, version: v.version, ...e })
        for (const s of skipped) censusSkipped.push({ component: comp.name, version: v.version, ...s })
      }
    }
    console.log(`[census] poisoned ${censusEntries.length} attribute value(s) across ` +
      `${new Set(censusEntries.map((e) => `${e.component}@${e.version}`)).size} component-version(s); ` +
      `${censusSkipped.length} left real (reserved/flag/empty)`)
  }

  const configs = asciidocConfigsByVersion(contentCatalog, siteConfig)
  // One stateless marker reused across pages; asciidoc-loader calls its register
  // per page with that page's file, so there is no cross-page leakage.
  const partialMarker = markPartials ? createPartialMarker() : null
  const withMarker = (cfg) => partialMarker
    ? { ...cfg, sourcemap: true, extensions: [...(cfg.extensions || []), partialMarker] }
    : cfg
  // Monospace normalization: backslash-escape `_`/`*` inside inline monospace so
  // Asciidoctor renders it literally (see normalize-monospace.js). Runs FIRST, on
  // clean source, before the marking passes. Unlike them it changes the render,
  // but is output-neutral wherever the emphasis was not firing -- so cloud/operator
  // stay byte-identical (their fidelity is the guardrail against over-reach).
  if (normalizeMonospace) {
    let fixed = 0
    for (const file of contentCatalog.getFiles()) {
      const fam = file.src && file.src.family
      if ((fam !== 'page' && fam !== 'partial') || !file.contents) continue
      const out = literalizeMonospace(file.contents.toString())
      if (out !== file.contents.toString()) { file.contents = Buffer.from(out); fixed++ }
    }
    if (fixed) console.log(`[snapshot] monospace normalization: rewrote ${fixed} source file(s)`)
  }

  // Attribute-reference marking: rewrite `{name}` -> `[.hz-attr-name]#{name}#`
  // in the source of every page/partial whose component has marked attributes,
  // BEFORE render, so the golden carries a marker span at each reference (see
  // mark-attributes.js). Operates on the in-memory catalog for this throwaway
  // render only; partials are transformed too, so a reference inside an included
  // partial is marked in the page that pulls it in.
  if (markAttributes) {
    let marked = 0
    for (const file of contentCatalog.getFiles()) {
      const fam = file.src && file.src.family
      if (fam !== 'page' && fam !== 'partial') continue
      const names = markedAttrsFor(file.src.component)
      if (!names.length || !file.contents) continue
      const wrapped = wrapRefs(file.contents.toString(), names)
      if (wrapped !== file.contents.toString()) { file.contents = Buffer.from(wrapped); marked++ }
    }
    if (marked) console.log(`[snapshot] attribute marking: instrumented ${marked} source file(s)`)
  }

  // Conditional marking: inject sentinels inside `ifdef::snapshot[]` blocks so
  // the converter can wrap snapshot-only content in <IfSnapshot> (see
  // mark-conditionals.js). Same in-memory-catalog rewrite as attribute marking;
  // sentinels gate with the conditional and strip byte-for-byte in readGolden().
  if (markConditionals) {
    let marked = 0
    for (const file of contentCatalog.getFiles()) {
      const fam = file.src && file.src.family
      if ((fam !== 'page' && fam !== 'partial') || !file.contents) continue
      const wrapped = wrapConditionals(file.contents.toString())
      if (wrapped !== file.contents.toString()) { file.contents = Buffer.from(wrapped); marked++ }
    }
    if (marked) console.log(`[snapshot] conditional marking: instrumented ${marked} source file(s)`)
  }

  const pagesDir = path.join(outDir, 'pages')
  fs.rmSync(pagesDir, { recursive: true, force: true })

  // Invalidate the golden-DERIVED caches (anchor index, inventory index, Layer-3
  // baseline). They are keyed by lockfileKey, but the golden CONTENT can change
  // with the pin unchanged -- any edit to this builder (e.g. the tutorial-list
  // injection or an xref-title fix) rewrites pages at the same SHAs. Since we are
  // regenerating the golden now, drop them so the next fidelity run rebuilds them
  // from the fresh pages rather than trusting a same-key stale copy.
  for (const f of ['anchor-index.json', 'inventory-index.json', 'layer3-baseline.json']) {
    fs.rmSync(path.join(outDir, f), { force: true })
  }

  const pages = contentCatalog
    .getPages((page) => page.out)
    .filter((page) => inScope(page.src.component))
  console.log(
    `[snapshot] rendering ${pages.length} pages` + (component ? ` (component=${component})` : '') + ' ...'
  )

  const errors = []
  const attrLeaks = []
  let written = 0
  for (const page of pages) {
    const cvKey = `${page.src.version}@${page.src.component}`
    try {
      const doc = loadAsciiDoc(page, contentCatalog, withMarker(configs.get(cvKey) || siteConfig))
      let html = doc.convert()
      // UI-injected tutorial list (see tutorialListHtml).
      if (doc.getAttributes()['page-include-tutorial-list']) {
        html += tutorialListHtml(contentCatalog, 'cloud')
      }
      // Turn attribute-reference sentinels into marker spans (mark-attributes.js).
      // Byte-faithfulness guard: a residual sentinel character means a marker
      // landed where spanify could not form a well-formed span (a broken run) --
      // the strip would then not reproduce the un-instrumented golden, the
      // invariant the whole approach rests on. Surface it loudly.
      if (markAttributes) {
        html = spanify(html)
        if (hasSentinelResidue(html)) {
          attrLeaks.push(`${page.src.version}@${page.src.component}:${page.src.module}:${page.src.relative}`)
        }
      }
      const dest = path.join(pagesDir, page.out.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, html.endsWith('\n') ? html : html + '\n')
      written++
    } catch (err) {
      errors.push({ id: `${cvKey}:${page.src.module}:${page.src.relative}`, message: err.message })
    }
  }
  if (attrLeaks.length) {
    console.error(`[snapshot] WARNING: attribute-marker leak on ${attrLeaks.length} page(s) -- strip is NOT byte-faithful there:`)
    for (const id of attrLeaks.slice(0, 20)) console.error(`             ${id}`)
    console.error('             Fix: add the leaking context to mark-attributes.js wrapRefs skips.')
  }

  // 100%-coverage partials registry (every partial$/page$ include in the
  // rendered corpus + whether the marker wrapped it). The converter cross-checks
  // its factored set against this so an include silently left inline (e.g. list
  // fusion) is still surfaced in partials-report.json. Lockfile-keyed alongside
  // the golden; regenerated on every snapshot, so no staleness.
  if (partialMarker) {
    const includes = partialMarker.getRegistry()
    fs.writeFileSync(path.join(outDir, 'partials-registry.json'),
      JSON.stringify({ lockfileKey: renderedKey, includes }, null, 2) + '\n')
    console.log(`[snapshot] partials registry: ${includes.length} include site(s) -> partials-registry.json`)
  }

  const meta = {
    builtAt: new Date().toISOString(),
    lockfileKey: renderedKey,
    playbook: path.relative(process.cwd(), playbookFile),
    // null = full corpus; a component name = a scoped (smoke) snapshot, NOT a
    // complete golden tree.
    component: component || null,
    counts: { pages: pages.length, written, errors: errors.length },
    versions: { antora: require('@antora/content-classifier/package.json').version },
  }
  fs.mkdirSync(outDir, { recursive: true })
  // A census tree is NOT a golden and must never be mistaken for one (its values
  // are poison tokens), so it gets its own meta file and no snapshot-meta.json.
  // The token table IS the census key: refcheck reads it to know what to look for
  // and what each token stood in for.
  if (census) {
    fs.writeFileSync(path.join(outDir, 'census-meta.json'), JSON.stringify({
      ...meta, kind: 'census', tokens: censusEntries, skipped: censusSkipped,
    }, null, 2) + '\n')
  } else {
    fs.writeFileSync(path.join(outDir, 'snapshot-meta.json'), JSON.stringify(meta, null, 2) + '\n')
  }
  if (errors.length) {
    fs.writeFileSync(path.join(outDir, 'snapshot-errors.json'), JSON.stringify(errors, null, 2) + '\n')
  }

  const metaFile = path.join(outDir, census ? 'census-meta.json' : 'snapshot-meta.json')
  console.log(
    `[${census ? 'census' : 'snapshot'}] wrote ${written}/${pages.length} pages to ${pagesDir}` +
      (errors.length ? ` (${errors.length} failed -> snapshot-errors.json)` : '') +
      `\n[${census ? 'census' : 'snapshot'}] key ${renderedKey.slice(0, 12)} -> ${metaFile}`
  )

  // Flush the log, then group the render errors into a ranked inventory.
  finalizeLogger()
  const report = summarizeErrors(logPath, outDir)
  const total = report.reduce((n, g) => n + g.count, 0)
  if (total) {
    console.log(`[snapshot] ${total} render errors in ${report.length} classes -> ${path.join(outDir, 'render-errors.json')}`)
    for (const g of report.slice(0, 10)) {
      console.log(`  ${String(g.count).padStart(6)}  ${g.class}  (${g.distinctTargets} distinct targets)`)
    }
  } else {
    console.log('[snapshot] no render errors')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
