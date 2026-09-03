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
const crypto = require('node:crypto')

const buildPlaybook = require('@antora/playbook-builder')
const yaml = require('js-yaml')

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
  tutorials: {
    // No `repo`: the component is assembled from 56 guide repos, one page each,
    // and a page's examples live in the same repo as that page. The source list
    // is read from the playbook (see multiRepoSources) rather than written here,
    // so adding or dropping a guide is a playbook edit only.
    mode: 'multi',
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
    playbookFile: path.resolve(val('--playbook', 'antora/index-playbook.yml')),
    dry: args.includes('--dry'),
  }
}

const outExamplesDir = (outRoot, component, ver) => path.join(outDirFor(outRoot, component, ver), 'examples')

// Gitignored staging dir for MULTI-mode examples, at the site root. Must match
// EXAMPLES_STAGING in converter/convert.js and plugins/tutorial-examples.
const EXAMPLES_STAGING = '.tutorial-examples'

// `https://github.com/hazelcast-guides/istio.git` -> `hazelcast-guides/istio`
const originSlug = (url) => (url || '').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '') || null

function gitShow (repoDir, ref, file) {
  try {
    // stderr silenced: a miss is signalled by the null return, and multi mode
    // probes a direct path before falling back to the symlink walk.
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
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

function gitConfig (repoDir, key) {
  try {
    return execFileSync('git', ['-C', repoDir, 'config', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function gitRevParse (repoDir, ref) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// Resolve a path whose leading segments may be git symlinks (mode 120000), as
// Antora does when it walks the worktree. Guides symlink their runnable source
// tree into the Antora examples dir -- `docs/modules/<m>/examples/src` ->
// `../../../../src` -- so `example$src/main/…` addresses real project code that
// exists nowhere under examples/. Returns null if a segment dead-ends.
function resolveGitLinks (repoDir, ref, p) {
  const segs = p.split('/')
  let cur = ''
  for (let i = 0; i < segs.length; i++) {
    cur = cur ? `${cur}/${segs[i]}` : segs[i]
    for (let hops = 0; ; hops++) {
      if (hops > 10) return null
      let entry
      try {
        entry = execFileSync('git', ['-C', repoDir, 'ls-tree', ref, '--', cur], { encoding: 'utf8' })
      } catch {
        return null
      }
      if (!entry.startsWith('120000')) break
      const target = gitShow(repoDir, ref, cur)
      if (target == null) return null
      cur = path.posix.normalize(path.posix.join(path.posix.dirname(cur), target.trim()))
    }
  }
  return cur
}

// The repos making up a MULTI-mode component, read from the playbook so the list
// has exactly one home and adding a guide stays a playbook-only edit. A source
// belongs to the component when the antora.yml at its start path declares that
// name -- the same test Antora itself applies, so the two can't disagree.
function multiRepoSources (playbookFile, component, sourcesDir) {
  const playbook = buildPlaybook(['--playbook', playbookFile], {})
  const out = []
  for (const src of playbook.content.sources) {
    const m = /(^|\/)([^/]+\.git)$/.exec(src.url)
    if (!m) continue
    const repoDir = path.join(sourcesDir, m[2])
    if (!fs.existsSync(repoDir)) continue
    const startPaths = src.startPaths && src.startPaths.length ? src.startPaths : [src.startPath || '']
    const branches = [].concat(src.branches || [])
    for (const raw of startPaths) {
      const startPath = String(raw).replace(/^\/+|\/+$/g, '')
      for (const ref of branches) {
        const desc = gitShow(repoDir, ref, startPath ? `${startPath}/antora.yml` : 'antora.yml')
        if (desc == null) continue
        let name
        try { name = yaml.load(desc).name } catch { continue }
        if (name !== component) continue
        out.push({
          repoDir,
          ref,
          startPath,
          repo: m[2].replace(/\.git$/, ''),
          // The upstream the staging fetch will read from, and the exact commit
          // it is pinned to -- the manifest records both so a build resolves the
          // same bytes the converter matched against.
          origin: gitConfig(repoDir, 'remote.origin.url'),
          sha: gitRevParse(repoDir, ref),
        })
      }
    }
  }
  return out
}

// Every `example$` file the branch's pages reference, as {module, rel} (multi
// mode). Unlike usage mode's flat grep this KEEPS the module coordinate: guides
// put examples in a named module as often as in ROOT
// (`standard-deviation:example$client/...`), and the module is a directory level,
// so dropping it makes the path unresolvable.
function referencedExamplesByModule (repoDir, ref, modulesDir) {
  const out = []
  let files
  try {
    files = execFileSync('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', ref, '--', modulesDir], { encoding: 'utf8' })
      .split('\n').filter((f) => f.endsWith('.adoc') && f.includes('/pages/'))
  } catch {
    return out
  }
  for (const f of files) {
    const txt = gitShow(repoDir, ref, f)
    if (txt == null) continue
    for (const m of txt.matchAll(/include::([^[]*example\$[^[]+)\[/g)) {
      const i = m[1].indexOf('example$')
      const rel = m[1].slice(i + 'example$'.length).replace(/^\/+/, '').trim()
      if (!rel) continue
      // [component:][module:] -- the LAST coordinate is the module; none means ROOT.
      const parts = m[1].slice(0, i).split(':').filter(Boolean)
      out.push({ module: parts.length ? parts[parts.length - 1] : 'ROOT', rel })
    }
  }
  return out
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

// MULTI mode: usage-based, but per source repo. Output is namespaced by repo
// because the rels are not globally unique across guides (`pom.xml` appears in
// two), and unversioned because the component is. The converter matches examples
// by CONTENT, not path, so the namespacing costs nothing at the include site.
// MULTI mode: the component's examples are NOT copied into this repo. They are
// the guide repos' runnable project files -- each repo symlinks `src/`, `client/`
// and friends into Antora's examples dir, and those files are compiled and
// dependency-maintained by that repo's own CI. A committed copy here would be a
// second, unmaintained fork of code that already has a home.
//
// So this mode emits a REFERENCE MANIFEST (repo + commit + path per file) and
// STAGES the bytes into a gitignored dir. The manifest is the committed artifact;
// plugins/tutorial-examples re-fetches from the pinned commit on every site build,
// exactly as plugins/openapi-specs does for the API specs. The staging dir exists
// so the converter can content-match a rendered code block back to its file --
// matching needs the bytes, and the golden has already inlined them.
function multiMain (opts) {
  const stagingDir = path.join(opts.outRoot, EXAMPLES_STAGING)
  // This mode owns the staging dir: a guide dropped from the playbook must not
  // leave its examples behind for the converter to match.
  if (!opts.dry) fs.rmSync(stagingDir, { recursive: true, force: true })

  const sources = multiRepoSources(opts.playbookFile, opts.component, opts.sourcesDir)
  const staged = new Map()
  const entries = []
  const missing = []
  let sites = 0
  let repos = 0

  for (const s of sources) {
    const refs = referencedExamplesByModule(s.repoDir, s.ref, `${s.startPath}/modules`)
    if (!refs.length) continue
    repos++
    for (const { module, rel } of refs) {
      sites++
      const from = `${s.startPath}/modules/${module}/examples/${rel}`
      // Always resolve links rather than reading `from` directly: `git show` on a
      // symlink returns the LINK TEXT, so a direct read of one succeeds with
      // `../../../../pom.xml` as the file body instead of failing.
      const real = resolveGitLinks(s.repoDir, s.ref, from)
      const raw = real == null ? null : gitShow(s.repoDir, s.ref, real)
      if (raw == null) { missing.push(`${s.repo}: ${module}:${rel}`); continue }
      // Namespaced by repo: the rels are not unique across guides (`pom.xml`
      // appears in two). The converter matches by CONTENT, so the id is only an
      // address, never part of the match.
      const id = path.posix.join(s.repo, rel)
      const prev = staged.get(id)
      if (prev !== undefined && prev !== raw) {
        console.error(`[extract-examples] ABORT: ${id} resolved twice with different content (${s.repo}, module ${module})`)
        process.exit(1)
      }
      if (prev !== undefined) continue
      staged.set(id, raw)
      entries.push({
        id,
        repo: originSlug(s.origin),
        ref: s.ref,
        sha: s.sha,
        path: real,
        // Hash of the exact bytes the converter content-matched against. The
        // build re-fetches from `sha` and verifies against this, so a page can
        // never publish code the migration did not see.
        sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      })
      if (!opts.dry) {
        const f = path.join(stagingDir, id)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, raw)
      }
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id))
  const manifestFile = path.join(outDirFor(opts.outRoot, opts.component, opts.versions[0]), 'examples.json')
  if (!opts.dry) {
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
    fs.writeFileSync(manifestFile, JSON.stringify({
      note: 'Generated by migration/extract-examples.js. Example files are NOT stored in this repo -- they are the guide repos\' runnable project files. plugins/tutorial-examples fetches each from `repo` at `sha` into the gitignored staging dir on every build.',
      files: entries,
    }, null, 2) + '\n')
  }

  console.log(`[extract-examples] ${opts.component}: ${entries.length} example file(s) from ${repos} repo(s), ${sites} include site(s)`)
  console.log(`[extract-examples]   manifest -> ${path.relative(process.cwd(), manifestFile)}`)
  console.log(`[extract-examples]   staged   -> ${path.relative(process.cwd(), stagingDir)} (gitignored, rebuilt on every site build)`)
  if (missing.length) {
    console.log(`[extract-examples] ${missing.length} not found: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`)
  }
}

function main () {
  const opts = parseArgs(process.argv)
  const cfg = REPOS[opts.component]
  if (!cfg) { console.error(`[extract-examples] no example config for component=${opts.component}`); process.exit(1) }
  if (cfg.mode === 'multi') return multiMain(opts)
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
