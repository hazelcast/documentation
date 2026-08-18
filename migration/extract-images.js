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
// Versioned components (operator) are supported: each version's images are
// co-located in its own tree -- latest-snapshot (main) at /<component>/images/
// and a release <v> at <component>_versioned_docs/version-<v>/images/ -- via
// destRel() below, keyed off the version segment in each image's pub.url.

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
const { isVersioned, currentSegFor, VERSIONS } = require('./lib/layout')

// A versioned component's LIVE set: current (main) + the releases this build
// emits. The golden spans every version (incl. frozen ones outside the live
// set), so image placement must be gated to the live set or we write orphan
// images for versions Docusaurus never builds. Unversioned components: no gate.
// The current seg is PER COMPONENT (currentSegFor) -- the default
// `latest-snapshot` is only operator's; MC's is `5.12-snapshot` and clc's is
// `5.5.1`, and gating those against the default would drop every current-version
// image on the floor.
function inLiveSet (component, url) {
  if (!isVersioned(component)) return true
  const releases = (VERSIONS[component] && VERSIONS[component].releases) || []
  const seg = url.replace(/^\/+/, '').split('/')[1] // /<component>/<seg>/…
  return new Set([currentSegFor(component), ...releases]).has(seg)
}

// Site-absolute pub.url -> repo-relative co-located destination (leading slash
// stripped, Antora's `_images` dir renamed to `images`). For a VERSIONED
// component the URL's version segment selects the tree: the component's CURRENT
// seg (main) lands in the plugin's current tree `<component>/images/`, and a
// release `<seg>` in `<component>_versioned_docs/version-<seg>/images/`. This
// per-version mapping MUST mirror the prefix imageSrc() strips in
// converter/lib/html-to-mdx.js, or the emitted references and the placed files
// disagree and the build breaks.
//
// A multi-module component (MC) keeps the module in the tail, because Antora
// publishes a module's images under `/<component>/<seg>/<module>/_images/…` and
// the converter's relative reference is resolved from the page's own output file.
function destRel (url) {
  const stripped = url.replace(/^\/+/, '').replace(/(^|\/)_images\//, '$1images/')
  const [component, seg, ...rest] = stripped.split('/')
  if (!isVersioned(component)) return stripped
  const tail = rest.join('/') // "images/foo.png", or "<module>/images/foo.png"
  return seg === currentSegFor(component)
    ? path.posix.join(component, tail)
    : path.posix.join(`${component}_versioned_docs`, `version-${seg}`, tail)
}

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
    .filter((file) => inLiveSet(file.src.component, file.pub.url))
    .filter((file) => all || referenced.has(file.pub.url))

  const perComponent = {}
  let written = 0
  let unchanged = 0
  let skipped = 0
  for (const file of images) {
    const url = file.pub.url
    const contents = file.contents
    if (!contents || !contents.length) { skipped++; continue }
    // pub.url is a site-absolute path (/cloud/_images/foo.png, or the versioned
    // /operator/5.16/_images/foo.png); destRel co-locates it in the docs tree,
    // renaming `_images`->`images` and, for versioned components, routing the
    // version segment to the right (current vs versioned_docs) tree. This layout
    // MUST match imageSrc() in converter/lib/html-to-mdx.js.
    const rel = destRel(url)
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
