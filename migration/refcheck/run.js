'use strict'

// The reference checker: the no-baking gate. The fidelity harness compares
// RENDERED golden vs RENDERED Docusaurus, so a baked-in value (an attribute,
// partial, or include resolved to a literal instead of kept as a reference)
// renders identically to the golden and is invisible to it BY CONSTRUCTION.
// This checker closes that hole from the SOURCE side: for every migrated page it
// reads the AsciiDoc source through its includes, and asserts the converted MDX
// still carries a reference for everything the source referenced.
//
//   node refcheck/run.js [--component cloud|operator] [--id /url]
//                        [--manifest build/manifest] [--out-root ..]
//                        [--sources .sources] [--json]
//
// Two checks, both source-anchored (a value is only expected where the source
// actually references it, so a coincidental literal is never flagged):
//   1. attributes -- every {name} the source resolves must survive as a
//      reference (<Variable>, a {name} link/code token, or a {name} in an
//      imported example file). A miss = a baked attribute. All referenced
//      attributes are checked; pure Antora machinery is filtered (bake-safe.js).
//   2. examples   -- every example$ include must survive as an import, not a
//      baked fence.
//
// Exit non-zero on any finding: this is a gate, not a report.

const fs = require('node:fs')
const path = require('node:path')

const { NAV_SOURCES, versionsToProcess, outDirFor, CURRENT_SEG } = require('../lib/layout')
const { collectPageRefs, locate } = require('./lib/source-refs')
const { indexOutput, reachableText, hasRef, exampleImports, urlToSlug } = require('./lib/mdx-refs')
const { isBakeSafe } = require('./lib/bake-safe')

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  return {
    component: val('--component', null), // null => every migrated component
    id: val('--id', null),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    outRoot: path.resolve(val('--out-root', '..')),
    sourcesDir: path.resolve(val('--sources', '.sources')),
    json: has('--json'),
  }
}

// Manifest attribute table for (component, seg): name -> resolved value.
function attrTable (manifest, component, seg) {
  const comp = (manifest.components || []).find((c) => c.name === component)
  if (!comp) return {}
  const key = seg == null ? '' : seg
  const v = (comp.versions || []).find((x) => (x.version || '') === key)
  return (v && v.attributes) || {}
}

// The migrated page resources for (component, seg).
function pagesFor (manifest, component, seg) {
  const key = seg == null ? '' : seg
  return (manifest.resources || []).filter((r) =>
    r.family === 'page' && r.component === component && (r.version || '') === key && r.url)
}

function main () {
  const opts = parseArgs(process.argv)
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))
  const components = opts.component ? [opts.component] : Object.keys(NAV_SOURCES)

  const findings = []      // baked attributes
  const exampleFindings = [] // baked example includes
  const counts = { pages: 0, checked: 0, pending: 0 }

  for (const component of components) {
    if (!NAV_SOURCES[component]) { console.error(`[refcheck] unknown component: ${component}`); process.exit(2) }
    for (const ver of versionsToProcess(component)) {
      const seg = ver.seg // null (unversioned), CURRENT_SEG, or a release
      const outDir = outDirFor(opts.outRoot, component, ver)
      const bySlug = indexOutput(outDir)
      const attrs = attrTable(manifest, component, seg)

      for (const resource of pagesFor(manifest, component, seg)) {
        if (opts.id && resource.url !== opts.id) continue
        counts.pages++
        const slug = urlToSlug(resource.url, component, seg)
        const pageFile = bySlug.get(slug)
        if (!pageFile) { counts.pending++; continue } // not converted yet -- not a regression
        counts.checked++

        const { names, examples } = collectPageRefs(resource, seg, opts.sourcesDir)
        const text = reachableText(pageFile, opts.outRoot)

        // (1) attributes
        for (const name of names) {
          if (isBakeSafe(name)) continue
          const value = attrs[name]
          if (value == null || String(value) === '') continue // not a component content attr / empty
          if (!hasRef(text, name)) {
            findings.push({ component, seg, url: resource.url, name, value: String(value) })
          }
        }

        // (2) examples: a page that pulls example$ includes must single-source
        // them as imports, not bake them as literal fences. The converter matches
        // examples by CONTENT, so an imported file may be named differently from
        // the include target (identical-content files are deduped to one import)
        // -- matching by name would false-positive on every dedup. So the gate is
        // the false-positive-free form: a page with example$ includes that
        // imports NO example file at all has baked them wholesale. (Partial
        // baking on a page that still imports >=1 example is not caught here; the
        // fidelity harness covers content, this covers single-sourcing.)
        if (examples.length && exampleImports(pageFile, opts.outRoot).size === 0) {
          exampleFindings.push({ component, seg, url: resource.url, count: examples.length })
        }
      }
    }
  }

  report(opts, counts, findings, exampleFindings)
  process.exit(findings.length + exampleFindings.length > 0 ? 1 : 0)
}

function report (opts, counts, findings, exampleFindings) {
  const outFile = path.resolve('build/refcheck-report.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: { component: opts.component, id: opts.id },
    counts, attributes: findings, examples: exampleFindings,
  }, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify({ counts, attributes: findings, examples: exampleFindings })); return }

  const scope = opts.id ? `id=${opts.id}` : opts.component ? `component=${opts.component}` : 'all migrated components'
  console.log(`\n[refcheck] ${scope}`)
  console.log(`[refcheck] pages in scope: ${counts.pages} | converted & checked: ${counts.checked} | not yet converted: ${counts.pending}`)

  if (!findings.length && !exampleFindings.length) {
    console.log('[refcheck] no baked references — every source {attribute}/example$ is preserved. ✓')
    return
  }

  if (findings.length) {
    // Group by (component, seg) then page for a readable gate output.
    const byPage = new Map()
    for (const f of findings) {
      const k = `${f.component}${f.seg ? '@' + f.seg : ''}  ${f.url}`
      if (!byPage.has(k)) byPage.set(k, [])
      byPage.get(k).push(f)
    }
    console.log(`\n[refcheck] ✗ ${findings.length} baked attribute reference(s) on ${byPage.size} page(s):`)
    for (const [k, fs_] of [...byPage].sort()) {
      console.log(`\n  ${k}`)
      for (const f of fs_) console.log(`      {${f.name}}  (resolved "${truncate(f.value)}")`)
    }
    // A by-attribute tally makes the triage decision (variableise vs bake-safe) obvious.
    const byName = new Map()
    for (const f of findings) byName.set(f.name, (byName.get(f.name) || 0) + 1)
    console.log('\n[refcheck] baked attributes by name (triage: variableise, or add to bake-safe.js):')
    for (const [name, n] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`      {${name}} × ${n}`)
  }

  if (exampleFindings.length) {
    console.log(`\n[refcheck] ✗ ${exampleFindings.length} page(s) bake ALL their example$ includes (no import at all):`)
    for (const e of exampleFindings.sort((a, b) => a.url.localeCompare(b.url))) {
      console.log(`      ${e.component}${e.seg ? '@' + e.seg : ''}  ${e.url}  (${e.count} example include(s))`)
    }
  }
  console.log(`\n[refcheck] report -> ${path.relative(process.cwd(), outFile)}`)
}

const truncate = (s) => (s.length > 60 ? s.slice(0, 57) + '…' : s)

main()
