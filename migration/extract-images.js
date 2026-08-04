'use strict'

// Extract image assets from the pinned Antora sources into the Docusaurus docs
// tree, CO-LOCATED with the pages that use them. Runs the same aggregator +
// classifier as the index pass (no UI, no document conversion), then writes every
// migrated component's image into an `images/` folder in the docs tree -- its
// published path rooted at the site, with Antora's `_images` dir renamed to
// `images` (e.g. /cloud/_images/foo.png -> new-docs/cloud/images/foo.png).
// The converter emits references RELATIVE to each page's output file (see
// imageSrc() in converter/lib/html-to-mdx.js), so webpack resolves and
// content-hashes them and a missing image fails the build instead of 404ing.
//
//   node extract-images.js [path/to/playbook.yml] [--root DIR] [--component X] [--dry-run]
//
// Scope matches the golden allowlist (MIGRATED below): images for resolution-only
// components (imdg, tutorials) are skipped -- those pages are never emitted, so
// nothing links to their images. Idempotent: identical files are left untouched,
// so a re-run produces zero git churn unless an image actually changed upstream.
//
// NOTE: unversioned components only for now (cloud lives at new-docs/cloud/). A
// versioned component's co-located home is versioned_docs/version-<v>/images/,
// not /<component>/<v>/images/ -- wire that up when the first versioned
// component migrates.

const fs = require('node:fs')
const path = require('node:path')

const buildPlaybook = require('@antora/playbook-builder')
const aggregateContent = require('@antora/content-aggregator')
const classifyContent = require('@antora/content-classifier')
const { resolveAsciiDocConfig } = require('@antora/asciidoc-loader')
const { configureLogger } = require('@antora/logger')

const { buildLockfile } = require('./antora-extension/emit-manifest')
const { lockfileKey, lockfileKeyFromFile } = require('./fidelity/lockfile-key')
const { goldenPages } = require('./fidelity/lib/pairing')
const { resolveHref } = require('./converter/lib/links')

// Keep in step with fidelity/build-snapshot.js: the components whose pages are
// emitted. Only their images are needed.
const MIGRATED = new Set([
  'hazelcast', 'management-center', 'clc', 'operator', 'cloud', 'jdbc-driver', 'home', 'privacy',
])

// The set of image URLs actually referenced by the migrated golden pages. With
// co-location an unreferenced image is a committed orphan (the cloud repo alone
// carries ~4.6MB of stale assets no page uses), so by default we place only what
// is referenced -- exactly the co-location win. Read straight from the golden
// (the faithful render), resolving each <img src> against its page URL the same
// way the converter does, so this and the emitted references cannot disagree.
function referencedImageUrls (goldenDir, inScope) {
  const urls = new Set()
  for (const page of goldenPages(goldenDir)) {
    if (!inScope(page.component)) continue
    const html = fs.readFileSync(page.file, 'utf8')
    for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/gi)) {
      const r = resolveHref(m[1], page.url)
      if (r.kind === 'internal') urls.add(r.path)
    }
  }
  return urls
}

function parseArgs (argv) {
  const args = argv.slice(2)
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  const flagValues = new Set(['--root', '--component', '--lockfile', '--golden'].map((f) => args.indexOf(f) + 1))
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagValues.has(i))
  return {
    playbookFile: path.resolve(positional[0] || 'antora/index-playbook.yml'),
    // Site root: pub.url is site-absolute (/cloud/_images/foo.png), so joining it
    // under the Docusaurus project root co-locates it in the docs tree.
    rootDir: path.resolve(valueOf('--root', path.join(__dirname, '..'))),
    goldenDir: path.resolve(valueOf('--golden', 'build/golden')),
    component: valueOf('--component', null),
    lockfileFile: path.resolve(valueOf('--lockfile', 'build/manifest/lockfile.json')),
    // Place every migrated component image, referenced or not. Off by default:
    // co-location means unreferenced images are just committed orphans.
    all: args.includes('--all'),
    dryRun: args.includes('--dry-run'),
  }
}

async function main () {
  const { playbookFile, rootDir, goldenDir, component, lockfileFile, all, dryRun } = parseArgs(process.argv)

  const playbook = buildPlaybook(['--playbook', playbookFile], {})
  configureLogger(playbook.runtime.log)

  const siteConfig = resolveAsciiDocConfig(playbook)
  console.log(`[extract-images] aggregating content from ${playbookFile} ...`)
  const aggregate = await aggregateContent(playbook)
  console.log(`[extract-images] classifying ${aggregate.length} component-version bundles ...`)
  const contentCatalog = classifyContent(playbook, aggregate, siteConfig)

  // Pin check: images should come from the same revision the manifest URLs were
  // resolved at. A mismatch is a warning, not a hard stop -- image filenames are
  // stable across revisions, so drifted bytes rarely mean a wrong URL (unlike the
  // golden snapshot, where a mismatched pin invalidates every diff).
  try {
    const renderedKey = lockfileKey(buildLockfile(contentCatalog))
    const committedKey = lockfileKeyFromFile(lockfileFile)
    if (committedKey !== renderedKey) {
      console.warn(
        '[extract-images] WARNING: local clones do not match the committed pin ' +
          `(${lockfileFile}). Extracting at the clones' current revision.`
      )
    }
  } catch { /* no committed lockfile yet -- nothing to check against */ }

  const inScope = (c) => component ? c === component : MIGRATED.has(c)

  // By default place only images referenced by the migrated golden pages (see
  // referencedImageUrls). --all overrides to place every in-scope component image.
  let referenced = null
  if (!all) {
    if (!fs.existsSync(path.join(goldenDir, 'pages'))) {
      console.error(
        `[extract-images] no golden pages at ${goldenDir}/pages -- run fidelity:snapshot ` +
          'first, or pass --all to place every component image regardless of references.'
      )
      process.exit(1)
    }
    referenced = referencedImageUrls(goldenDir, inScope)
    console.log(`[extract-images] ${referenced.size} image(s) referenced by the golden`)
  }

  const images = contentCatalog.findBy({ family: 'image' })
    .filter((file) => file.pub && file.pub.url && inScope(file.src.component))
    .filter((file) => all || referenced.has(file.pub.url))

  const perComponent = {}
  let written = 0
  let unchanged = 0
  let skipped = 0
  for (const file of images) {
    const url = file.pub.url
    const contents = file.contents
    if (!contents || !contents.length) { skipped++; continue }
    // pub.url is a site-absolute path (/cloud/_images/foo.png); strip the leading
    // slash so it joins under the project root rather than the filesystem root,
    // and rename Antora's `_images` dir to our `images`. This `_images`->`images`
    // rewrite MUST match the one in converter/lib/html-to-mdx.js (imageSrc), or
    // references and files disagree.
    const rel = url.replace(/^\/+/, '').replace(/(^|\/)_images\//, '$1images/')
    const dest = path.join(rootDir, rel)

    let changed = true
    try {
      changed = !fs.readFileSync(dest).equals(contents)
    } catch { /* absent -> write it */ }

    const key = file.src.component + (file.src.version ? `@${file.src.version}` : '')
    perComponent[key] = perComponent[key] || { written: 0, unchanged: 0 }
    if (!changed) { unchanged++; perComponent[key].unchanged++; continue }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, contents)
    }
    written++
    perComponent[key].written++
  }

  console.log(
    `[extract-images] ${dryRun ? '[dry-run] would write' : 'wrote'} ${written} image(s), ` +
      `${unchanged} unchanged` + (skipped ? `, ${skipped} empty skipped` : '') +
      ` -> ${rootDir}`
  )
  for (const key of Object.keys(perComponent).sort()) {
    const c = perComponent[key]
    console.log(`  ${key.padEnd(32)} ${c.written} written, ${c.unchanged} unchanged`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
