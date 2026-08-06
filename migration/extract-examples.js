'use strict'

// Co-locate a versioned component's `example$` include files so the migration
// keeps them SINGLE-SOURCED (imported at build) instead of baking each into the
// prose. See the docusaurus-example-includes-decision note.
//
//   node extract-examples.js --component operator [--versions latest-snapshot,5.18]
//                            [--sources .sources] [--out-root ..] [--dry]
//
// For each version it reads that branch's pages, finds every `include::…example$/
// FILE[]`, pulls the referenced file from the branch, resolves any `{attribute}`
// placeholders from the manifest's per-version attributes (Antora does this via
// `subs="attributes+"`; a raw import would otherwise leave `{…}` literal), and
// writes the resolved file into that version's co-located `examples/` folder:
//   latest-snapshot -> ../<component>/examples/
//   release X       -> ../<component>_versioned_docs/version-X/examples/
// The converter then content-matches a golden code block to one of these files
// and emits a raw-loader import + <CodeBlock> instead of a fence.
//
// Whole-file includes only (operator uses no tag/line slicing); tagged includes
// (Platform's Java) are a later extension.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Branch model per versioned component (mirror of convert.js NAV_SOURCES).
const REPOS = {
  operator: { repo: 'hazelcast-platform-operator-docs.git', examplesDir: 'docs/modules/ROOT/examples', pagesGlob: 'docs/modules/ROOT/pages' },
}
const CURRENT_SEG = 'latest-snapshot'
const DEFAULT_VERSIONS = { operator: [CURRENT_SEG, '5.18'] }

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
  const component = val('--component', 'operator')
  const versionsArg = val('--versions', null)
  return {
    component,
    versions: versionsArg ? versionsArg.split(',').map((s) => s.trim()).filter(Boolean) : (DEFAULT_VERSIONS[component] || []),
    sourcesDir: path.resolve(val('--sources', '.sources')),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    outRoot: path.resolve(val('--out-root', '..')),
    dry: args.includes('--dry'),
  }
}

const branchFor = (seg) => (seg === CURRENT_SEG ? 'main' : `v/${seg}`)

function outExamplesDir (outRoot, component, seg) {
  return seg === CURRENT_SEG
    ? path.join(outRoot, component, 'examples')
    : path.join(outRoot, `${component}_versioned_docs`, `version-${seg}`, 'examples')
}

function gitShow (repoDir, ref, file) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

// Every distinct `example$/…` file referenced by the branch's pages.
function referencedExampleFiles (repoDir, ref, pagesGlob) {
  let out
  try {
    out = execFileSync('git', ['-C', repoDir, 'grep', '-h', '-oE', 'example\\$/?[^][]+', ref, '--', `${pagesGlob}/*.adoc`], { encoding: 'utf8' })
  } catch {
    return []
  }
  const rels = new Set()
  for (const m of out.split('\n')) {
    if (!m) continue
    // strip the `example$` marker and any leading slash -> path under examples/
    const rel = m.replace(/^.*example\$\/?/, '').trim()
    if (rel) rels.add(rel)
  }
  return [...rels]
}

function main () {
  const opts = parseArgs(process.argv)
  const cfg = REPOS[opts.component]
  if (!cfg) { console.error(`[extract-examples] no example config for component=${opts.component}`); process.exit(1) }
  const repoDir = path.join(opts.sourcesDir, cfg.repo)

  let total = 0
  for (const seg of opts.versions) {
    const ref = branchFor(seg)
    const rels = referencedExampleFiles(repoDir, ref, cfg.pagesGlob)
    const dir = outExamplesDir(opts.outRoot, opts.component, seg)

    let written = 0
    const missing = []
    for (const rel of rels) {
      const raw = gitShow(repoDir, ref, `${cfg.examplesDir}/${rel}`)
      if (raw == null) { missing.push(rel); continue }
      // Write the file BYTE-FAITHFUL — keep Antora {attribute} placeholders
      // intact so the co-located copy stays a true single source of the
      // engineers' file. The placeholders are resolved per version at BUILD by
      // the example-attributes webpack loader (no baking here). See the
      // docusaurus-attributes-no-baking decision.
      if (!opts.dry) {
        const f = path.join(dir, rel)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, raw)
      }
      written++
    }
    total += written
    console.log(`[extract-examples] ${opts.component}@${seg}: ${written} example file(s) -> ${path.relative(process.cwd(), dir)}` +
      (missing.length ? `  (${missing.length} not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})` : ''))
  }
  console.log(`[extract-examples] ${total} file(s) across ${opts.versions.length} version(s)`)
}

main()
