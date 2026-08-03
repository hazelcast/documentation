'use strict'

// Converter CLI: turn golden HTML fragments into Docusaurus MDX pages, laid out
// per the component's Antora nav.adoc.
//
//   node converter/convert.js --component cloud [--out ../cloud]
//                             [--id /cloud/cluster-side-modules] [--dry] [--verbose]
//
// Input  : build/golden/pages/<component>/**.html (the faithful Antora render)
//          + build/manifest/manifest.json (titles + resource inventory)
//          + the component's nav.adoc (from the frozen source mirror)
// Output : <out>/**.mdx laid out to mirror the nav tree, each page carrying a
//          `slug` that preserves its flat Antora URL, plus `sidebar_label` /
//          `sidebar_position`; and a `_category_.json` per category folder.
//
// The nav's parent-pages (both a page and a parent) are emitted as a category
// folder with the page content in `overview.mdx`. See lib/nav.js.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { goldenPages } = require('../fidelity/lib/pairing')
const { convertBody } = require('./lib/html-to-mdx')
const { collectOccurrences, decide } = require('./lib/partials')
const { parseNav, buildPlan } = require('./lib/nav')

// Where each component's nav.adoc lives in the frozen mirrors. Cloud only for
// now; generalises (with a version dimension) as more components migrate.
const NAV_SOURCES = {
  cloud: { repo: 'cloud-docs.git', ref: 'main', file: 'docs/modules/ROOT/nav.adoc' },
}

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  const has = (flag) => args.includes(flag)
  const component = val('--component', 'cloud')
  return {
    component,
    id: val('--id', null),
    goldenDir: path.resolve(val('--golden', 'build/golden')),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    sourcesDir: path.resolve(val('--sources', '.sources')),
    outDir: path.resolve(val('--out', path.join('..', component))),
    dry: has('--dry'),
    verbose: has('--verbose'),
  }
}

// url -> page-resource; and a stem -> title map for the nav planner. The stem
// map MUST be scoped to the component: bare stems like "overview" recur across
// nearly every component (often literally titled "Overview"), so an unscoped map
// would clobber cloud's titles with another component's.
function indexManifest (manifest, component) {
  const byUrl = new Map()
  const titleByStem = new Map()
  const prefix = `/${component}/`
  for (const r of manifest.resources || []) {
    if (r.family !== 'page' || !r.url) continue
    byUrl.set(r.url, r)
    if (r.title && r.url.startsWith(prefix)) titleByStem.set(r.url.split('/').pop(), r.title)
  }
  return { byUrl, titleByStem }
}

function loadNavAdoc (component, sourcesDir) {
  const src = NAV_SOURCES[component]
  if (!src) return null
  const repoDir = path.join(sourcesDir, src.repo)
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${src.ref}:${src.file}`], { encoding: 'utf8' })
  } catch (err) {
    console.warn(`[convert] could not read nav.adoc for ${component} (${err.message.split('\n')[0]}); falling back to flat layout`)
    return null
  }
}

function frontmatter (title, { derived, slug, sidebarLabel, sidebarPosition, unlisted } = {}) {
  const lines = ['---', `title: ${yaml(title)}`]
  if (sidebarLabel) lines.push(`sidebar_label: ${yaml(sidebarLabel)}`)
  if (sidebarPosition != null) lines.push(`sidebar_position: ${sidebarPosition}`)
  if (slug) lines.push(`slug: ${slug}`)
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

function main () {
  const opts = parseArgs(process.argv)
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))
  const { byUrl, titleByStem } = indexManifest(manifest, opts.component)

  // Nav-driven plan (file layout, slugs, sidebar metadata, categories).
  const navAdoc = loadNavAdoc(opts.component, opts.sourcesDir)
  const plan = navAdoc
    ? buildPlan(parseNav(navAdoc), titleByStem)
    : { pages: new Map(), categories: [], duplicates: [] }

  const allPages = goldenPages(opts.goldenDir).filter((p) => p.component === opts.component)
  let pages = allPages
  if (opts.id) pages = pages.filter((p) => p.url === opts.id)
  if (pages.length === 0) {
    console.error(`[convert] no golden pages for component=${opts.component}${opts.id ? ' id=' + opts.id : ''}`)
    process.exit(1)
  }

  // Pass 1: read each page's golden ONCE (cached) and collect its partial-
  // boundary sentinel regions, then make the corpus-wide factoring decision.
  // Collection always spans the WHOLE component (not the --id subset) so a
  // single-page run makes the same decisions a full run would. A golden built
  // without --mark-partials simply yields no sentinels -> no partials, and the
  // rest of the pipeline is unchanged.
  const htmlByUrl = new Map()
  const readGoldenRaw = (p) => {
    if (!htmlByUrl.has(p.url)) htmlByUrl.set(p.url, fs.readFileSync(p.file, 'utf8'))
    return htmlByUrl.get(p.url)
  }
  const pagesOcc = allPages.map((p) => ({ url: p.url, occ: collectOccurrences(readGoldenRaw(p)) }))
  const { decisions, report } = decide(pagesOcc)

  // Full (non-scoped) run regenerates the whole component tree from scratch, so
  // stale files from a previous layout do not linger.
  if (!opts.dry && !opts.id) fs.rmSync(opts.outDir, { recursive: true, force: true })

  let written = 0
  const orphans = []
  const problems = []
  for (const p of pages) {
    const stem = p.url.split('/').pop()
    const entry = plan.pages.get(stem)
    if (!entry) orphans.push(p.url)
    const relFile = entry ? entry.relFile : stem + '.mdx'

    const html = readGoldenRaw(p)
    const rec = byUrl.get(p.url)
    let title = rec && rec.title
    let derived = false
    if (!title) { title = deriveTitle(html); derived = true }
    if (!title) { title = stem.replace(/-/g, ' '); derived = true }

    let body, imports
    try {
      ({ body, imports } = convertBody(html, { pageUrl: p.url, partials: decisions }))
    } catch (err) {
      problems.push({ url: p.url, error: err.message })
      continue
    }

    const fm = frontmatter(title, {
      derived,
      slug: entry ? entry.slug : null,
      sidebarLabel: entry ? entry.sidebarLabel : null,
      sidebarPosition: entry ? entry.sidebarPosition : null,
      unlisted: !entry, // orphan (not in nav)
    })
    const importBlock = imports.size ? [...imports].join('\n') + '\n\n' : ''
    const mdx = fm + '\n\n' + importBlock + body + '\n'

    const outFile = path.join(opts.outDir, relFile)
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
  // keeps Docusaurus from routing it). Its own imports (Tabs, etc.) ride at the
  // top of the partial file, so the pages that use it need only the one import
  // the placeholder already added.
  let partialsWritten = 0
  const partialProblems = []
  for (const [id, d] of decisions) {
    try {
      const { body, imports } = convertBody(d.representative, { pageUrl: pages[0].url, partials: decisions })
      const importBlock = imports.size ? [...imports].join('\n') + '\n\n' : ''
      d.mdx = importBlock + body + '\n'
    } catch (err) {
      partialProblems.push({ id, error: err.message })
      continue
    }
    if (!opts.dry) {
      const f = path.join(opts.outDir, '_partials', d.slug + '.mdx')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, d.mdx)
    }
    partialsWritten++
  }

  // Audit trail: what was factored and what was declined (and why).
  const factored = report.filter((r) => r.decision === 'factored')
  const declined = report.filter((r) => r.decision === 'declined')

  // 100%-coverage cross-check against the golden's partials registry (every
  // partial$/page$ include site, marked or not). Any included id that produced
  // no sentinel -- so it never reached decide() -- is surfaced here as `unmarked`
  // (left inline; typically not block-liftable, e.g. list-continuation fusion).
  // This is what caught mfa-enable, which was otherwise silently dropped.
  const reportIds = new Set(report.map((r) => r.id))
  const unmarked = []
  const regPath = path.join(opts.goldenDir, 'partials-registry.json')
  if (fs.existsSync(regPath)) {
    const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'))
    const byId = new Map()
    for (const row of registry.includes || []) {
      if (!row.id.startsWith(opts.component + ':')) continue
      if (!byId.has(row.id)) byId.set(row.id, { id: row.id, family: row.family, pages: [] })
      byId.get(row.id).pages.push(row.page)
    }
    for (const [id, info] of byId) {
      if (reportIds.has(id)) continue
      unmarked.push({ id, family: info.family, occurrences: info.pages.length, pages: info.pages.sort(), decision: 'unmarked', reason: 'inlined (no liftable block — e.g. list-continuation fusion or mid-paragraph splice)' })
    }
    unmarked.sort((a, b) => a.id.localeCompare(b.id))
  }

  // The report is an internal audit artifact, not doc content, so it is written
  // under build/ (gitignored) rather than into the published output tree.
  if (!opts.dry && (report.length || unmarked.length)) {
    const reportDir = path.dirname(opts.goldenDir)
    fs.mkdirSync(reportDir, { recursive: true })
    fs.writeFileSync(path.join(reportDir, `partials-report-${opts.component}.json`),
      JSON.stringify({
        component: opts.component,
        counts: { total: report.length + unmarked.length, factored: factored.length, declined: declined.length, unmarked: unmarked.length },
        partials: [...report, ...unmarked],
      }, null, 2) + '\n')
  }

  // Category descriptor files.
  let cats = 0
  if (!opts.dry && !opts.id) {
    for (const c of plan.categories) {
      const f = path.join(opts.outDir, c.relFile)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify(c.content, null, 2) + '\n')
      cats++
    }
  }

  console.log(`[convert] component=${opts.component}: ${written} page(s)` +
    (opts.dry ? ' converted (dry-run)' : ` + ${cats} categor${cats === 1 ? 'y' : 'ies'} written to ${path.relative(process.cwd(), opts.outDir)}`))
  if (report.length || unmarked.length) {
    console.log(`[convert] partials: ${factored.length} factored -> _partials/ (${partialsWritten} written), ${declined.length} declined, ${unmarked.length} unmarked (inlined)`)
    for (const r of declined) console.log(`   • declined ${r.id} (${r.reason}, ${r.occurrences}×)`)
    for (const r of unmarked) console.log(`   • unmarked ${r.id} (${r.reason}, ${r.occurrences}×)`)
  }
  if (partialProblems.length) {
    console.log(`[convert] ${partialProblems.length} partial(s) failed to convert:`)
    for (const pr of partialProblems) console.log(`   ✗ ${pr.id}: ${pr.error}`)
    process.exit(1)
  }
  if (plan.duplicates.length) console.log(`[convert] nav duplicates (kept first): ${[...new Set(plan.duplicates)].join(', ')}`)
  if (orphans.length) console.log(`[convert] ${orphans.length} page(s) NOT in nav (placed flat): ${orphans.map((u) => u.split('/').pop()).join(', ')}`)
  if (problems.length) {
    console.log(`[convert] ${problems.length} page(s) failed:`)
    for (const pr of problems) console.log(`   ✗ ${pr.url}: ${pr.error}`)
    process.exit(1)
  }
}

main()
