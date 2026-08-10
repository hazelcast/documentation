'use strict'

// The construct-coverage gate. The fidelity harness compares RENDERED output and
// so is blind to WHICH source construct produced a given rendering; the two
// misses that motivated this gate (a cross-component example include, an `ifdef`
// conditional) were invisible to it for exactly that reason. This gate closes the
// hole from the SOURCE side: for every CONVERTED page it reads the AsciiDoc
// source through its includes, enumerates every construct it uses (lexical + AST,
// see lib/detect.js), and asserts each one is on the allowlist.
//
//   node constructcheck/run.js [--component cloud|operator] [--manifest …]
//                              [--out-root ..] [--sources .sources] [--json]
//                              [--no-ast]
//
// The allowlist (constructcheck/allowlist.json) is DENY-BY-DEFAULT: an entry
// means "a human has verified this construct converts correctly on a real
// migrated page." It ships EMPTY, so the gate currently flags every construct in
// the migrated set — nothing is trusted until verified. As the audit promotes
// constructs, the flagged set shrinks; when a newly-migrated page introduces an
// unclassified construct, it reappears here instead of slipping through.
//
// Exit non-zero on any unclassified construct: this is a gate, not a report.

const fs = require('node:fs')
const path = require('node:path')

const { NAV_SOURCES, versionsToProcess, outDirFor } = require('../lib/layout')
const { indexOutput, urlToSlug } = require('../refcheck/lib/mdx-refs')
const { locate, includesIn, resolveTarget, sliceByTags, stripComments } = require('../refcheck/lib/source-refs')
const { detectLexical, detectAst, gitShow } = require('./lib/detect')

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  return {
    component: val('--component', null),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    outRoot: path.resolve(val('--out-root', '..')),
    sourcesDir: path.resolve(val('--sources', '.sources')),
    json: has('--json'),
    ast: !has('--no-ast'),
  }
}

function pagesFor (manifest, component, seg) {
  const key = seg == null ? '' : seg
  return (manifest.resources || []).filter((r) =>
    r.family === 'page' && r.component === component && (r.version || '') === key && r.url)
}

function loadAllowlist () {
  const p = path.join(__dirname, 'allowlist.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  return new Set(raw.allow || [])
}

// Walk a converted page's source through its includes, collecting the distinct
// constructs it uses. `seen` maps `category:token` -> first {url, where, raw} for
// readable reporting. Mirrors refcheck's collectPageRefs include expansion.
function collectPageConstructs (resource, seg, sourcesDir, useAst, url, seen) {
  const start = { component: resource.component, module: resource.module || 'ROOT', family: 'page', relative: resource.relative }
  const visited = new Set()

  const record = (c, where) => {
    const key = `${c.category}:${c.token}`
    if (!seen.has(key)) seen.set(key, { url, where, raw: c.raw || '' })
  }

  const walk = (coord, tag) => {
    const loc = locate(coord, seg, sourcesDir)
    if (!loc) return
    const key = `${loc.ref}:${loc.repoPath}${tag ? '#' + tag : ''}`
    if (visited.has(key)) return
    visited.add(key)
    const rawText = gitShow(loc.repoDir, loc.ref, loc.repoPath)
    if (rawText == null) return
    const scanText = stripComments(sliceByTags(rawText, tag))

    for (const c of detectLexical(scanText)) record(c, `${loc.repoPath}:${c.line}`)
    // AST parses the whole (unsliced) file so fragments do not mis-parse; it only
    // ever adds block-level kinds, never removes a lexical finding.
    if (useAst) for (const c of detectAst(stripComments(rawText))) record(c, loc.repoPath)

    for (const inc of includesIn(scanText)) {
      const child = resolveTarget(inc.target, coord)
      if (child) walk(child, inc.tag)
    }
  }

  walk(start, null)
}

function main () {
  const opts = parseArgs(process.argv)
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))
  const allow = loadAllowlist()
  const components = opts.component ? [opts.component] : Object.keys(NAV_SOURCES)

  const seen = new Map() // category:token -> {url, where, raw}
  const counts = { pages: 0, checked: 0, pending: 0 }

  for (const component of components) {
    if (!NAV_SOURCES[component]) { console.error(`[constructcheck] unknown component: ${component}`); process.exit(2) }
    for (const ver of versionsToProcess(component)) {
      const seg = ver.seg
      const bySlug = indexOutput(outDirFor(opts.outRoot, component, ver))
      for (const resource of pagesFor(manifest, component, seg)) {
        counts.pages++
        const slug = urlToSlug(resource.url, component, seg)
        if (!bySlug.has(slug)) { counts.pending++; continue } // not converted yet -- out of scope
        counts.checked++
        collectPageConstructs(resource, seg, opts.sourcesDir, opts.ast, resource.url, seen)
      }
    }
  }

  const unclassified = [...seen.entries()]
    .filter(([key]) => !allow.has(key))
    .map(([key, info]) => ({ key, ...info }))
    .sort((a, b) => a.key.localeCompare(b.key))

  report(opts, counts, unclassified, allow.size, seen.size)
  process.exit(unclassified.length > 0 ? 1 : 0)
}

function report (opts, counts, unclassified, allowSize, total) {
  const outFile = path.resolve('build/constructcheck-report.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: { component: opts.component, ast: opts.ast },
    counts, allowlisted: allowSize, distinctConstructs: total, unclassified,
  }, null, 2) + '\n')

  if (opts.json) { console.log(JSON.stringify({ counts, unclassified })); return }

  const scope = opts.component ? `component=${opts.component}` : 'all migrated components (cloud, operator)'
  console.log(`\n[constructcheck] ${scope}`)
  console.log(`[constructcheck] pages in scope: ${counts.pages} | converted & scanned: ${counts.checked} | not yet converted: ${counts.pending}`)
  console.log(`[constructcheck] distinct constructs seen: ${total} | allowlisted (verified): ${allowSize} | unclassified: ${unclassified.length}`)

  if (!unclassified.length) {
    console.log('[constructcheck] every construct in the migrated set is verified & allowlisted. ✓')
    return
  }

  const byCat = new Map()
  for (const u of unclassified) {
    const cat = u.key.slice(0, u.key.indexOf(':'))
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(u)
  }
  console.log(`\n[constructcheck] ✗ ${unclassified.length} unclassified construct(s) — verify on the cited page, then add the key to allowlist.json:`)
  for (const [cat, items] of [...byCat].sort()) {
    console.log(`\n  ${cat}  (${items.length})`)
    for (const u of items) {
      console.log(`      ${u.key}`)
      console.log(`          ${u.url}`)
      console.log(`          ${u.where}${u.raw ? '   ' + u.raw : ''}`)
    }
  }
  console.log(`\n[constructcheck] report -> ${path.relative(process.cwd(), outFile)}`)
}

main()
