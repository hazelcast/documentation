'use strict'

// Converter CLI: turn golden HTML fragments into Docusaurus MDX pages.
//
//   node converter/convert.js --component cloud [--out ../cloud]
//                             [--id /cloud/cluster-side-modules] [--dry]
//
// Input  : build/golden/pages/<component>/**.html (the faithful Antora render)
//          + build/manifest/manifest.json (titles + resource inventory)
// Output : <out>/**.mdx, one file per golden page, path mirroring the site URL
//          so the Docusaurus route matches the current Antora URL exactly.
//
// The converter is deliberately scoped by component: we iterate cloud first
// (unversioned, 69 pages) and let `npm run fidelity -- --component cloud` grade
// each pass. It renders nothing itself.

const fs = require('node:fs')
const path = require('node:path')

const { goldenPages } = require('../fidelity/lib/pairing')
const { convertBody } = require('./lib/html-to-mdx')

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
    // Default output dir = repo-root/<component> (one docs-plugin instance per
    // component, routeBasePath === component).
    outDir: path.resolve(val('--out', path.join('..', component))),
    dry: has('--dry'),
    verbose: has('--verbose'),
  }
}

// Build url -> page-resource lookup (for titles) from the manifest.
function pageMetaIndex (manifest) {
  const byUrl = new Map()
  for (const r of manifest.resources || []) {
    if (r.family === 'page' && r.url) byUrl.set(r.url, r)
  }
  return byUrl
}

// Frontmatter for a page. Title comes from the manifest doctitle; the handful of
// pages that open with a section heading (== instead of =) have no doctitle, so
// we derive the title from that first heading and hide the duplicate frontmatter
// h1 (hide_title) to stay faithful to the golden body, which keeps the heading.
function frontmatter (title, { derived } = {}) {
  const lines = ['---', `title: ${yaml(title)}`]
  if (derived) lines.push('hide_title: true')
  lines.push('---')
  return lines.join('\n')
}

function yaml (s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// Derive a title from the first heading in the golden fragment (fallback for
// pages whose source lacks a doctitle).
function deriveTitle (html) {
  const m = html.match(/<h[1-6][^>]*>(?:<a[^>]*><\/a>)?([\s\S]*?)<\/h[1-6]>/i)
  if (!m) return null
  return m[1].replace(/<[^>]+>/g, '').replace(/&#8217;|&#x2019;/g, "'").replace(/\s+/g, ' ').trim()
}

// Golden url -> output file path. Mirrors the site URL under outDir; a directory
// URL ("/cloud/") becomes index.mdx. The component prefix is stripped because
// outDir already represents the component's route base.
function outFileFor (url, component, outDir) {
  let rel = url.replace(new RegExp(`^/${component}/?`), '')
  if (rel === '' || url.endsWith('/')) rel = path.join(rel, 'index')
  return path.join(outDir, rel + '.mdx')
}

function main () {
  const opts = parseArgs(process.argv)
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.manifestDir, 'manifest.json'), 'utf8'))
  const meta = pageMetaIndex(manifest)

  let pages = goldenPages(opts.goldenDir).filter((p) => p.component === opts.component)
  if (opts.id) pages = pages.filter((p) => p.url === opts.id)
  if (pages.length === 0) {
    console.error(`[convert] no golden pages for component=${opts.component}${opts.id ? ' id=' + opts.id : ''}`)
    process.exit(1)
  }

  let written = 0
  const problems = []
  for (const p of pages) {
    const html = fs.readFileSync(p.file, 'utf8')
    const rec = meta.get(p.url)
    let title = rec && rec.title
    let derived = false
    if (!title) { title = deriveTitle(html); derived = true }
    if (!title) { title = p.url.split('/').pop().replace(/-/g, ' '); derived = true }

    let body, imports
    try {
      ({ body, imports } = convertBody(html, { pageUrl: p.url }))
    } catch (err) {
      problems.push({ url: p.url, error: err.message })
      continue
    }

    const importBlock = imports.size ? [...imports].join('\n') + '\n\n' : ''
    const mdx = frontmatter(title, { derived }) + '\n\n' + importBlock + body + '\n'

    const outFile = outFileFor(p.url, opts.component, opts.outDir)
    if (opts.dry) {
      if (opts.verbose) console.log(`--- ${p.url} -> ${path.relative(process.cwd(), outFile)} ---\n${mdx}`)
    } else {
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, mdx)
    }
    written++
  }

  console.log(`[convert] component=${opts.component}: ${written} page(s) ${opts.dry ? 'converted (dry-run)' : 'written to ' + path.relative(process.cwd(), opts.outDir)}`)
  if (problems.length) {
    console.log(`[convert] ${problems.length} page(s) failed:`)
    for (const pr of problems) console.log(`   ✗ ${pr.url}: ${pr.error}`)
    process.exit(1)
  }
}

main()
