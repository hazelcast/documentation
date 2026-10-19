'use strict'

// The sidebar gate. Asserts that each migrated component version's Docusaurus
// sidebar is the Antora nav: the same entries, labels, URLs, nesting and order.
//
// Both sides come from the real thing, not from the converter. Antora's side is
// @antora/navigation-builder run over the pinned sources, which is what renders
// the live nav. Docusaurus's side is the sidebar Docusaurus generated, read from
// the version metadata in ../.docusaurus, which `npm run build` or a running
// `npm start` writes. Build the site after converting, as for the fidelity gate.
//
//   node sidebarcheck/run.js [--component X] [--playbook FILE] [--json]
//
// Exit 1 on any difference, 2 on a bad invocation or a missing built sidebar.

const fs = require('node:fs')
const path = require('node:path')

const buildNavigation = require('@antora/navigation-builder')
const { buildContentCatalog } = require('../lib/catalog')
const { registerPageAliases } = require('../antora-extension/register-page-aliases')
const { NAV_SOURCES, versionsToProcess, outDirFor } = require('../lib/layout')
const { logicalKey } = require('../orphancheck/lib/reachability')
const { loadDispositions, redirectRoute } = require('../lib/dispositions')
const { antoraLines, docusaurusLines, diffLines, splitInjected, pageOf } = require('./lib/compare')

const GENERATED = path.resolve(__dirname, '../../.docusaurus/docusaurus-plugin-content-docs')

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1] }
  return { component: val('--component', null), playbook: val('--playbook', 'antora/index-playbook.yml'), json: args.includes('--json') }
}

// The built sidebar for one version. .docusaurus keeps stale files from earlier
// version sets, so match on the version label and take the newest.
function builtSidebar (component, seg) {
  const dir = path.join(GENERATED, component, 'p')
  if (!fs.existsSync(dir)) return null
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs, v: JSON.parse(fs.readFileSync(file, 'utf8')).version }))
    .filter(({ v }) => (seg ? v.label.toLowerCase() === seg.toLowerCase() : v.version === 'current'))
    .sort((a, b) => b.mtime - a.mtime)
  if (!hits.length) return null
  const { v, file, mtime } = hits[0]
  return { items: Object.values(v.docsSidebars)[0] || [], file, mtime }
}

// Docusaurus's dev server ignores `unlisted` (every item says `unlisted: false`)
// and only a production build hides those docs, so the doc's own frontmatter is
// the one reliable source.
function unlistedIn (component, vp) {
  const dir = outDirFor(path.resolve(__dirname, '../..'), component, vp)
  return (item) => {
    if (!item.docId) return false
    const file = ['.mdx', '.md'].map((e) => path.join(dir, item.docId + e)).find((f) => fs.existsSync(f))
    const fm = file ? (fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '' : ''
    return /^unlisted: true$/m.test(fm)
  }
}

async function main () {
  const opts = parseArgs(process.argv)
  const components = opts.component ? [opts.component] : Object.keys(NAV_SOURCES)
  for (const c of components) if (!NAV_SOURCES[c]) { console.error(`[sidebarcheck] unknown component: ${c}`); process.exit(2) }

  const { contentCatalog: cat, asciidocConfig } = await buildContentCatalog(opts.playbook, { silent: true })
  // Primes page.asciidoc.navtitle, which an empty-text nav xref renders as its label.
  registerPageAliases(cat, asciidocConfig)
  const navCatalog = buildNavigation(cat, asciidocConfig)

  // Pages the orphan allowlist injects into a version's nav (`nav.after`): an
  // intended Docusaurus-only entry, decided and recorded there.
  const allow = JSON.parse(fs.readFileSync(path.join(__dirname, '../orphancheck/allowlist.json'), 'utf8')).allow || {}
  const urlByKey = new Map()
  const dispositions = loadDispositions()
  const redirects = new Map()
  for (const p of cat.findBy({ family: 'page' })) {
    if (!p.pub || !p.pub.url) continue
    const { component, module, relative, version = '' } = p.src
    urlByKey.set(`${version}|${logicalKey({ component, module, relative })}`, pageOf(p.pub.url))
    if (!NAV_SOURCES[component]) continue
    const route = redirectRoute(dispositions, { component, module, relative, version, url: pageOf(p.pub.url) })
    if (route) redirects.set(pageOf(p.pub.url), route)
  }
  const injectedUrls = (seg) => new Set(Object.entries(allow)
    .filter(([, e]) => e.nav && (!e.versions || e.versions.includes(seg)))
    .map(([key]) => urlByKey.get(`${seg}|${key}`)).filter(Boolean))

  const results = []
  let missing = 0
  for (const component of components) {
    for (const vp of versionsToProcess(component)) {
      const seg = vp.seg === null ? '' : vp.seg
      const built = builtSidebar(component, vp.seg)
      if (!built) { missing++; results.push({ component, version: seg, missing: true }); continue }
      const menus = navCatalog.getNavigation(component, seg) || []
      const own = `/${component}`
      const { lines, duplicates, otherProduct } = antoraLines(menus, (u) => redirects.get(u) || null, (u) => !u.startsWith('/') || pageOf(u) === own || u.startsWith(own + '/'))
      const { removed, added: allAdded } = diffLines(lines, docusaurusLines(built.items, unlistedIn(component, vp)))
      const { injected, rest: added } = splitInjected(allAdded, injectedUrls(seg))
      results.push({ component, version: seg, removed, added, duplicates, otherProduct, injected, builtFrom: path.relative(process.cwd(), built.file), builtAt: new Date(built.mtime).toISOString() })
    }
  }

  const outFile = path.resolve('build/sidebarcheck-report.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n')

  const failing = results.filter((r) => !r.missing && (r.removed.length || r.added.length))
  if (opts.json) console.log(JSON.stringify(results))
  else {
    for (const r of results) {
      const id = `${r.component}${r.version ? '@' + r.version : ''}`
      if (r.missing) { console.log(`[sidebarcheck] ✗ ${id}: no built sidebar in .docusaurus (run npm run build)`); continue }
      const ok = !r.removed.length && !r.added.length
      console.log(`[sidebarcheck] ${ok ? '✓' : '✗'} ${id}: ${r.removed.length} missing, ${r.added.length} extra | expected: ${r.duplicates.length} duplicate(s) dropped, ${r.otherProduct.length} other-product dropped, ${r.injected.length} injected  (built ${r.builtAt})`)
      for (const l of r.removed) console.log(`      - ${l}`)
      for (const l of r.added) console.log(`      + ${l}`)
    }
    console.log(`\n[sidebarcheck] ${failing.length} version(s) differ from the Antora nav. "-" = in Antora only, "+" = in Docusaurus only.`)
    console.log(`[sidebarcheck] report -> ${path.relative(process.cwd(), outFile)}`)
  }
  process.exit(missing ? 2 : failing.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(2) })
