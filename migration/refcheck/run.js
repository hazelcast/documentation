'use strict'

// The reference checker: the no-baking gate. The fidelity harness compares
// RENDERED golden vs RENDERED Docusaurus, so a baked-in value (an attribute or
// include resolved to a literal instead of kept as a reference) renders
// identically to the golden and is invisible to it BY CONSTRUCTION. This checker
// closes that hole -- and it does so by ACCOUNTING, not by sampling:
//
//   expected  the census render (attributes replaced by unique tokens, see
//             antora-extension/poison-attributes.js) says exactly how many times
//             each attribute flowed onto each page, and into what position
//   actual    the converted MDX closure (page + partials + example files, each
//             counted once per USE) says how many references it still carries
//
// and the two must be EQUAL. Consequences of counting rather than asking
// "is this name mentioned somewhere on the page?", which is what this replaced:
//   - partial baking is caught (5 occurrences, 4 baked, 1 left -> 5 != 1);
//   - OVER-variableising is caught too (actual > expected), i.e. the converter
//     turning a coincidental literal into a <Variable> -- previously invisible,
//     and after cutover there is no golden left to notice it;
//   - nothing is ever matched on an attribute's real VALUE, so a page containing
//     the literal "5.7.0" (operator's CRD default table does) cannot be mistaken
//     for a reference to a 5.7.0-valued attribute.
//
// Findings mean defects. Positions where preservation is structurally impossible
// (an anchor id, image alt text, an xref label copied from a page title) are
// recorded as dispositions by refcheck/lib/bake-contexts.js and reported as a
// tally, never as failures -- so a clean conversion produces an empty gate.
//
//   node refcheck/run.js [--component cloud|operator] [--id /url]
//                        [--census build/census] [--golden build/golden]
//                        [--manifest build/manifest] [--out-root ..]
//                        [--sources .sources] [--json]
//
// Exit non-zero on any finding: this is a gate, not a report.

const fs = require('node:fs')
const path = require('node:path')

const { NAV_SOURCES, versionsToProcess, outDirFor } = require('../lib/layout')
const { stagedIdsByPath } = require('../lib/staged-examples')
const { collectPageExamples } = require('./lib/source-refs')
const { indexOutput, refCounts, exampleImports, frontmatterTokens, urlToSlug } = require('./lib/mdx-refs')
const { scanCensusPage, unmaskGuard, hiddenBranchComponents } = require('./lib/census-ledger')
const { loadDispositions, isUnpublished } = require('../lib/dispositions')
const { loadAccepted, applyAccepted } = require('../lib/accepted')
const { goldenPages } = require('../fidelity/lib/pairing')
const { lockfileKeyFromFile } = require('../fidelity/lockfile-key')

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  return {
    component: val('--component', null), // null => every migrated component
    id: val('--id', null),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    censusDir: path.resolve(val('--census', 'build/census')),
    goldenDir: path.resolve(val('--golden', 'build/golden')),
    outRoot: path.resolve(val('--out-root', '..')),
    sourcesDir: path.resolve(val('--sources', '.sources')),
    json: has('--json'),
  }
}

// The migrated page resources for (component, seg).
// Pages an orphan triage decision does not publish (drop-404 or redirect) are
// excluded: nothing is emitted for them, so they are out of scope rather than
// "not yet converted".
function pagesFor (manifest, component, seg, dispositions) {
  const key = seg == null ? '' : seg
  return (manifest.resources || []).filter((r) =>
    r.family === 'page' && r.component === component && (r.version || '') === key && r.url &&
    !(dispositions && isUnpublished(dispositions, r)))
}

// url -> HTML file, for a census or golden pages tree.
const byUrl = (dir) => new Map(goldenPages(dir).map((p) => [p.url, p.file]))

// The accept-list key for a finding: OCCURRENCE-EXACT, so it pins the counts and
// not just the page. Accepting "expected 12, found 11" does not accept "found 10"
// — a second baked occurrence on the same page changes the key and fails.
function acceptKey (f) {
  const where = `refs:${f.cls}:${f.component}@${f.seg || ''} ${f.url} `
  if (f.cls === 'examples') return `${where}${f.reason || f.count + ' example include(s)'}`
  if (f.cls === 'inert') return `${where}{${f.name}} ×${f.count}`
  return `${where}{${f.name}} ${f.expected}->${f.actual}`
}

function main () {
  const opts = parseArgs(process.argv)
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))

  const censusMetaFile = path.join(opts.censusDir, 'census-meta.json')
  if (!fs.existsSync(censusMetaFile)) {
    console.error(`[refcheck] ABORT: no census render at ${path.relative(process.cwd(), opts.censusDir)}.\n` +
      '           Build it first:  npm run census' +
      (opts.component ? ` -- --component ${opts.component}` : ''))
    process.exit(2)
  }
  const census = JSON.parse(fs.readFileSync(censusMetaFile, 'utf8'))
  // The census is only valid at the pin it was rendered at: its tokens are keyed
  // to that pin's component-version attribute tables, and the manifest pages it
  // is joined to come from the same pin. A stale census would compare a page
  // against another revision's expectations.
  const pin = lockfileKeyFromFile(path.join(opts.manifestDir, 'lockfile.json'))
  if (census.lockfileKey !== pin) {
    console.error(`[refcheck] ABORT: the census render is stale (built at ${String(census.lockfileKey).slice(0, 12)},` +
      ` the committed pin is ${String(pin).slice(0, 12)}).\n           Rebuild it:  npm run census` +
      (opts.component ? ` -- --component ${opts.component}` : ''))
    process.exit(2)
  }
  const censusByUrl = byUrl(opts.censusDir)
  const goldenByUrl = byUrl(opts.goldenDir)

  const components = opts.component ? [opts.component] : Object.keys(NAV_SOURCES)

  // Every attribute name the census knows about, for the frontmatter scan (a
  // token there is inert wherever it appears, not only on pages that reference it).
  const CENSUS_NAMES = [...new Set(census.tokens.map((t) => t.name))]

  const baked = []          // expected > actual: a reference was resolved to a literal
  const extra = []          // actual > expected: a literal was turned into a reference
  const inert = []          // a {name} token somewhere Docusaurus never interpolates
  const unknownCtx = []     // a token in a position with no disposition -> fail closed
  const guardFails = []     // unmasking the census did not reproduce the golden
  const exampleFindings = []
  const dispositionTally = new Map()
  const counts = { pages: 0, checked: 0, pending: 0, noCensus: 0, anchorDerived: 0, exPages: 0, exSites: 0, exUses: 0, exOver: 0 }
  const dispositions = loadDispositions()
  const { accept, errors: acceptErrors } = loadAccepted(path.join(__dirname, 'accepted.json'))

  for (const component of components) {
    if (!NAV_SOURCES[component]) { console.error(`[refcheck] unknown component: ${component}`); process.exit(2) }
    // One manifest per component, shared by all its versions.
    const stagedIds = stagedIdsByPath(component, opts.outRoot)
    for (const ver of versionsToProcess(component)) {
      const seg = ver.seg // null (unversioned), CURRENT_SEG, or a release
      const outDir = outDirFor(opts.outRoot, component, ver)
      const bySlug = indexOutput(outDir)

      for (const resource of pagesFor(manifest, component, seg, dispositions)) {
        if (opts.id && resource.url !== opts.id) continue
        counts.pages++
        const slug = urlToSlug(resource.url, component, seg)
        const pageFile = bySlug.get(slug)
        if (!pageFile) { counts.pending++; continue } // not converted yet -- not a regression
        const censusFile = censusByUrl.get(resource.url)
        if (!censusFile) { counts.noCensus++; continue } // census not rendered for this scope
        counts.checked++

        const scope = { component, seg, url: resource.url }
        const censusHtml = fs.readFileSync(censusFile, 'utf8')
        // A spliced page carries BOTH halves of a `snapshot` conditional; this
        // version renders one. The census says which, so the MDX side can ignore
        // the other instead of reporting it as a surplus reference.
        const hiddenBranches = hiddenBranchComponents(censusHtml)

        // --- (1) attributes: exact per-page accounting -----------------------
        const { preserve, bakes, unknown } = scanCensusPage(censusHtml, { tokens: census.tokens })
        for (const u of unknown) unknownCtx.push({ ...scope, ...u })
        for (const b of bakes) {
          const key = `${b.name}  ${b.disposition}`
          dispositionTally.set(key, (dispositionTally.get(key) || 0) + 1)
        }
        if (preserve.size) {
          const names = [...preserve.keys()]
          const actual = refCounts(pageFile, opts.outRoot, names, { hiddenBranches })
          for (const [name, expected] of preserve) {
            const got = actual.get(name) || 0
            if (got < expected) baked.push({ ...scope, name, expected, actual: got })
            else if (got > expected) extra.push({ ...scope, name, expected, actual: got })
          }
        }
        // A token in the YAML frontmatter is inert -- nothing interpolates it, so
        // it reaches the reader as literal braces. Its own class of finding: it is
        // neither a baked value nor a surplus reference.
        for (const [name, n] of frontmatterTokens(fs.readFileSync(pageFile, 'utf8'), CENSUS_NAMES)) {
          inert.push({ ...scope, name, count: n })
        }

        // --- (2) the census guard -------------------------------------------
        // Poisoning must have changed only the substituted text. If putting the
        // real values back does not reproduce the golden (beyond derived anchor
        // ids), the ledger above was read off an untrustworthy render.
        const goldenFile = goldenByUrl.get(resource.url)
        if (goldenFile) {
          const { verdict, residual } = unmaskGuard(censusFile, goldenFile, census.tokens)
          if (verdict === 'anchor-derived') counts.anchorDerived++
          if (verdict === 'differs') guardFails.push({ ...scope, reason: 'unmasked census != golden' })
          if (residual.length) guardFails.push({ ...scope, reason: `unrecoverable token(s): ${residual.join(', ')}` })
        }

        // --- (3) examples ----------------------------------------------------
        // A page that pulls example$ includes must single-source them as imports,
        // not bake them as literal fences. This is an ACCOUNTING, not a floor:
        // one import used once per include site, drawn from a file the page
        // actually names.
        //
        // Two independent facts are checked, because they fail differently:
        //
        //   count  -- USES of example imports must equal include sites. Uses, not
        //     imports: a page showing ten regions of one file has ten include
        //     sites and ten imports, but a page showing one region twice has two
        //     sites and one (deduped) import used twice. The old floor passed a
        //     page that imported 1 of its 10 slices and baked the rest, which is
        //     exactly what the accidental partial-factoring used to do.
        //
        //   file   -- every imported example must be one the page's own source
        //     includes. Content matching alone cannot tell two byte-identical
        //     files apart (GroupingClusters.java / GroupingClusters2.java), and
        //     importing the wrong one severs the doc<->source link silently: the
        //     page keeps rendering the other file's copy for ever.
        //
        // Selectors are deliberately NOT compared. `lines=36..47` and `tag=fib`
        // can name the same region (executor-service does exactly this), and the
        // converter is right to prefer the tag; the count and the file are what
        // carry the guarantee.
        const examples = collectPageExamples(resource, seg, opts.sourcesDir)
        if (examples.length) {
          // A cross-component include names the file by its path in the repo that
          // owns it; the staged copy the page imports is addressed by manifest id.
          // Same file, two names -- translate, or every staged import reads as one
          // the page never asked for.
          const wanted = new Set(examples.map((c) => {
            const rel = String(c.relative).replace(/^\/+/, '')
            return stagedIds.get(rel) || rel
          }))
          const imported = exampleImports(pageFile, opts.outRoot)
          let uses = 0
          const foreign = []
          counts.exPages++
          counts.exSites += examples.length
          for (const im of imported.values()) {
            uses += im.uses
            if (!wanted.has(im.rel)) foreign.push(im.rel + im.query)
          }
          counts.exUses += uses
          // Over-use is surfaced, not failed. A page can legitimately render an
          // example more often than its source includes it -- both halves of a
          // spliced `snapshot` conditional are present in the MDX though only one
          // reaches the reader. But it is worth SEEING, because an over-count on
          // one example could otherwise net out a genuine bake of another.
          if (uses > examples.length) counts.exOver++
          if (uses < examples.length) {
            exampleFindings.push({ ...scope, count: examples.length, uses, reason: `${examples.length - uses} of ${examples.length} example include(s) baked` })
          } else if (foreign.length) {
            exampleFindings.push({ ...scope, count: examples.length, uses, reason: `imports example(s) the page does not include: ${foreign.slice(0, 3).join(', ')}` })
          }
        }
      }
    }
  }

  // Accepted findings (refcheck/accepted.json): understood, still reported, not
  // blocking. Only the classes that represent a KNOWN CONVERSION GAP are
  // acceptable. `unknownCtx` and `guardFails` deliberately are not: the first
  // means a rendering position has no policy yet, the second that the census the
  // expectations were read from cannot be trusted — in both cases the gate cannot
  // judge the page at all, so accepting one would silence everything behind it.
  const acceptable = [
    ...baked.map((f) => ({ ...f, cls: 'baked' })),
    ...extra.map((f) => ({ ...f, cls: 'extra' })),
    ...inert.map((f) => ({ ...f, cls: 'inert' })),
    ...exampleFindings.map((f) => ({ ...f, cls: 'examples' })),
  ]
  const { blocking, accepted, stale } = applyAccepted(acceptable, accept, acceptKey, (key) =>
    (!opts.component || key.includes(`:${opts.component}@`)) && (!opts.id || key.includes(` ${opts.id} `)))

  const findings = {
    baked: blocking.filter((f) => f.cls === 'baked'),
    extra: blocking.filter((f) => f.cls === 'extra'),
    inert: blocking.filter((f) => f.cls === 'inert'),
    examples: blocking.filter((f) => f.cls === 'examples'),
    unknownCtx,
    guardFails,
    accepted,
    stale,
    acceptErrors,
  }
  report(opts, counts, findings, dispositionTally)
  process.exit(blocking.length + unknownCtx.length + guardFails.length +
    stale.length + acceptErrors.length > 0 ? 1 : 0)
}

function report (opts, counts, f, dispositionTally) {
  const outFile = path.resolve('build/refcheck-report.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: { component: opts.component, id: opts.id },
    counts,
    baked: f.baked,
    extra: f.extra,
    inert: f.inert,
    unknownContexts: f.unknownCtx,
    guardFailures: f.guardFails,
    examples: f.examples,
    dispositions: [...dispositionTally].map(([k, n]) => ({ disposition: k, count: n })),
    // Accepted findings are IN the report as well as on the console: the record of
    // what is known-broken has to be readable without re-running the gate.
    accepted: f.accepted.map((a) => ({ key: a.key, ...a.entry, finding: a.finding })),
    staleAcceptedKeys: f.stale,
    acceptErrors: f.acceptErrors,
  }, null, 2) + '\n')

  if (opts.json) {
    console.log(JSON.stringify({ counts, ...f }))
    return
  }

  const scope = opts.id ? `id=${opts.id}` : opts.component ? `component=${opts.component}` : 'all migrated components'
  console.log(`\n[refcheck] ${scope}`)
  console.log(`[refcheck] pages in scope: ${counts.pages} | converted & checked: ${counts.checked}` +
    ` | not yet converted: ${counts.pending}` +
    (counts.noCensus ? ` | no census page: ${counts.noCensus}` : ''))

  // Recorded dispositions: positions where a reference CANNOT be preserved. Not
  // findings -- printed so the cost of those decisions stays visible.
  if (dispositionTally.size) {
    const total = [...dispositionTally.values()].reduce((a, b) => a + b, 0)
    console.log(`[refcheck] ${total} occurrence(s) correctly baked (structurally unpreservable):`)
    for (const [key, n] of [...dispositionTally].sort((a, b) => b[1] - a[1])) console.log(`      ${key} × ${n}`)
  }
  if (counts.anchorDerived) {
    console.log(`[refcheck] census guard: ${counts.anchorDerived} page(s) differ from golden only in derived anchor ids (expected)`)
  }
  if (counts.exSites) {
    // Say the accounting out loud. A gate that only speaks when it fails cannot
    // be told apart from a gate that is not running -- and this one silently
    // passed a 110-of-179 shortfall while it was only a floor.
    console.log(`[refcheck] examples: ${counts.exUses}/${counts.exSites} example$ include site(s) single-sourced across ${counts.exPages} page(s)` +
      (counts.exOver ? `  (${counts.exOver} page(s) render an example more often than the source includes it — expected where a conditional branch is spliced)` : ''))
  }

  // Accepted: reported EVERY run, deliberately above the pass/fail line. The
  // point of the accept-list is to stop these blocking the gate, not to hide them.
  if (f.accepted.length) {
    console.log(`\n[refcheck] ${f.accepted.length} accepted finding(s) — understood, not blocking (refcheck/accepted.json):`)
    for (const a of f.accepted.sort((x, y) => x.key.localeCompare(y.key))) {
      console.log(`      [${a.entry.disposition}] ${a.key}`)
      console.log(`          ${a.entry.note}`)
    }
  }

  const clean = !f.baked.length && !f.extra.length && !f.inert.length &&
    !f.unknownCtx.length && !f.guardFails.length && !f.examples.length &&
    !f.stale.length && !f.acceptErrors.length
  if (clean) {
    console.log('[refcheck] every attribute occurrence the census recorded is still a reference' +
      (f.accepted.length ? ', apart from the accepted findings above' : '') + '. ✓')
    return
  }

  if (f.acceptErrors.length) {
    console.log(`\n[refcheck] ✗ refcheck/accepted.json is malformed (${f.acceptErrors.length}):`)
    for (const e of f.acceptErrors) console.log(`      ${e}`)
  }

  if (f.stale.length) {
    console.log(`\n[refcheck] ✗ ${f.stale.length} STALE accepted entr${f.stale.length === 1 ? 'y' : 'ies'}` +
      ' — the finding no longer occurs, so the file now claims a defect that is fixed. Prune it:')
    for (const k of f.stale) console.log(`      ${k}`)
  }

  const byPage = (list) => {
    const m = new Map()
    for (const x of list) {
      const k = `${x.component}${x.seg ? '@' + x.seg : ''}  ${x.url}`
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(x)
    }
    return [...m].sort()
  }

  if (f.baked.length) {
    console.log(`\n[refcheck] ✗ ${f.baked.length} baked reference(s) on ${byPage(f.baked).length} page(s) — fewer references than the source resolved:`)
    for (const [k, rows] of byPage(f.baked)) {
      console.log(`\n  ${k}`)
      for (const r of rows) console.log(`      {${r.name}}  expected ${r.expected}, found ${r.actual}`)
    }
    const byName = new Map()
    for (const r of f.baked) byName.set(r.name, (byName.get(r.name) || 0) + (r.expected - r.actual))
    console.log('\n[refcheck] baked occurrences by attribute:')
    for (const [name, n] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`      {${name}} × ${n}`)
  }

  if (f.extra.length) {
    console.log(`\n[refcheck] ✗ ${f.extra.length} OVER-variableised reference(s) — more references than the source resolved` +
      ' (a coincidental literal turned into a <Variable>; it will follow the wrong value when the attribute changes):')
    for (const [k, rows] of byPage(f.extra)) {
      console.log(`\n  ${k}`)
      for (const r of rows) console.log(`      {${r.name}}  expected ${r.expected}, found ${r.actual}`)
    }
  }

  if (f.inert.length) {
    console.log(`\n[refcheck] ✗ ${f.inert.length} INERT token(s) in YAML frontmatter — nothing interpolates frontmatter,` +
      ' so this reaches the reader as literal braces:')
    for (const r of f.inert) {
      console.log(`      ${r.component}${r.seg ? '@' + r.seg : ''}  ${r.url}  {${r.name}}${r.count > 1 ? ' × ' + r.count : ''}`)
    }
  }

  if (f.unknownCtx.length) {
    console.log(`\n[refcheck] ✗ ${f.unknownCtx.length} attribute occurrence(s) in a position with NO disposition` +
      ' — classify it in refcheck/lib/bake-contexts.js (preserve, or bake with a reason):')
    for (const r of f.unknownCtx.slice(0, 30)) {
      console.log(`      ${r.url}  {${r.name}}  <${r.tag}${r.attr ? ' ' + r.attr + '=' : ''}>`)
    }
  }

  if (f.guardFails.length) {
    console.log(`\n[refcheck] ✗ census guard FAILED on ${f.guardFails.length} page(s) — poisoning changed the render itself,` +
      ' so the expectations read off it cannot be trusted:')
    for (const r of f.guardFails.slice(0, 30)) console.log(`      ${r.url}  ${r.reason}`)
  }

  if (f.examples.length) {
    console.log(`\n[refcheck] ✗ ${f.examples.length} page(s) do not single-source their example$ includes:`)
    for (const e of f.examples.sort((a, b) => a.url.localeCompare(b.url))) {
      console.log(`      ${e.component}${e.seg ? '@' + e.seg : ''}  ${e.url}  ${e.reason || `(${e.count} example include(s))`}`)
    }
  }
  console.log(`\n[refcheck] report -> ${path.relative(process.cwd(), outFile)}`)
}

main()
