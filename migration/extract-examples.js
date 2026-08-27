'use strict'

// Co-locate a component's `example$` include files so the migration keeps them
// SINGLE-SOURCED (imported at build) instead of baking each into the prose. See
// the docusaurus-example-includes-decision note.
//
//   node extract-examples.js --component operator [--versions latest-snapshot,5.18]
//                            [--sources .sources] [--out-root ..] [--dry]
//
// Two placement modes, per component (REPOS[*].mode):
//
//   usage  (operator) -- copy only the files the branch's pages actually
//     include. Right for standalone samples: one file, one page, nothing else
//     depends on it.
//
//   tree   (hazelcast/Platform) -- copy the WHOLE examples tree, structure
//     preserved. Platform's examples are a Maven source root: `pom.xml` sets
//     sourceDirectory to this tree and CI compiles all of it against the real
//     hazelcast-enterprise artifact. The unit that has to compile is the tree,
//     not the referenced subset -- 26 of the 173 .java files are referenced by
//     no page, and helper classes the referenced ones depend on live among
//     them. A usage-based copy would not compile. Tree mode also prunes: it
//     owns the whole directory, so a file deleted upstream must not linger.
//
// Files are written BYTE-FAITHFUL -- Antora {attribute} placeholders stay
// intact, resolved per version at BUILD by the example-attributes webpack
// loader (no baking here; see docusaurus-attributes-no-baking). Tag/line
// slicing likewise happens at build, in tag-slice-loader, from the ?tag= /
// ?lines= query the converter puts on the import.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { currentSegFor, refFor, versionsToProcess, outDirFor } = require('./lib/layout')

// Example-file source per component: which mirror holds them, where the tree
// lives in that repo, and how to place them here. `pagesGlob` is only read in
// usage mode (tree mode never scans pages).
const REPOS = {
  operator: {
    repo: 'hazelcast-platform-operator-docs.git',
    examplesDir: 'docs/modules/ROOT/examples',
    pagesGlob: 'docs/modules/ROOT/pages',
    mode: 'usage',
  },
  hazelcast: {
    repo: 'hz-docs.git',
    examplesDir: 'docs/modules/ROOT/examples',
    mode: 'tree',
  },
}

function parseArgs (argv) {
  const args = argv.slice(2)
  const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1] }
  const component = val('--component', 'operator')
  const versionsArg = val('--versions', null)
  // An explicit --versions list carries no kind; derive it the way
  // versionsToProcess does, so outDirFor lands the tree in the right place.
  const versions = versionsArg
    ? versionsArg.split(',').map((s) => s.trim()).filter(Boolean)
      .map((seg) => ({ seg, kind: seg === currentSegFor(component) ? 'current' : 'release' }))
    : versionsToProcess(component)
  return {
    component,
    versions,
    sourcesDir: path.resolve(val('--sources', '.sources')),
    manifestDir: path.resolve(val('--manifest', 'build/manifest')),
    outRoot: path.resolve(val('--out-root', '..')),
    dry: args.includes('--dry'),
  }
}

const outExamplesDir = (outRoot, component, ver) => path.join(outDirFor(outRoot, component, ver), 'examples')

function gitShow (repoDir, ref, file) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

// Every distinct `example$/…` file referenced by the branch's pages (usage mode).
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

// Every file in the branch's examples tree (tree mode), as paths under it.
function allExampleFiles (repoDir, ref, examplesDir) {
  let out
  try {
    out = execFileSync('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', ref, '--', examplesDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return []
  }
  return out.split('\n')
    .filter(Boolean)
    .map((p) => p.slice(examplesDir.length).replace(/^\//, ''))
    .filter(Boolean)
}

function main () {
  const opts = parseArgs(process.argv)
  const cfg = REPOS[opts.component]
  if (!cfg) { console.error(`[extract-examples] no example config for component=${opts.component}`); process.exit(1) }
  const repoDir = path.join(opts.sourcesDir, cfg.repo)
  const tree = cfg.mode === 'tree'

  let total = 0
  for (const ver of opts.versions) {
    const ref = refFor(opts.component, ver.seg)
    const rels = tree
      ? allExampleFiles(repoDir, ref, cfg.examplesDir)
      : referencedExampleFiles(repoDir, ref, cfg.pagesGlob)
    const dir = outExamplesDir(opts.outRoot, opts.component, ver)

    // Tree mode owns the directory: clear it so an upstream deletion is not
    // preserved here as a stale file the converter could still content-match.
    if (tree && !opts.dry) fs.rmSync(dir, { recursive: true, force: true })

    let written = 0
    const missing = []
    for (const rel of rels) {
      const raw = gitShow(repoDir, ref, `${cfg.examplesDir}/${rel}`)
      if (raw == null) { missing.push(rel); continue }
      if (!opts.dry) {
        const f = path.join(dir, rel)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, raw)
      }
      written++
    }
    total += written
    console.log(`[extract-examples] ${opts.component}@${ver.seg}: ${written} example file(s) (${cfg.mode}) -> ${path.relative(process.cwd(), dir)}` +
      (missing.length ? `  (${missing.length} not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''})` : ''))
  }
  console.log(`[extract-examples] ${total} file(s) across ${opts.versions.length} version(s)`)
}

main()
