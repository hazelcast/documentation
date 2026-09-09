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

const { currentSegFor, refFor, versionsToProcess, outDirFor, sourceMirrorFor } = require('./lib/layout')
// The symlink-aware reads, shared with refcheck so the two cannot disagree about
// what a path through a git symlink resolves to.
const { gitShow, resolveGitLinks } = require('./lib/git-links')
// The staging dir name, shared with the converter and refcheck.
const { EXAMPLES_STAGING } = require('./lib/staged-examples')

// Example-file source per component: which mirror holds them, where the tree
// lives in that repo, and how to place them here. `pagesGlob` is only read in
// usage mode (tree mode never scans pages).
const REPOS = {
  operator: {
    repo: 'hazelcast-platform-operator-docs.git',
    modulesDir: 'docs/modules',
    mode: 'usage',
    // Operator's tutorial pages include example$ files from ANOTHER component --
    // `templates`, which is hazelcast-code-samples. Those are staged BY REFERENCE
    // (manifest + build-time fetch) rather than copied: they are that repo's
    // runnable sample projects, with their own CI, and they are byte-identical
    // across every operator version, so copying would commit the same 51 files
    // five times over. The mirror they come from is not restated here --
    // lib/layout's READ_ONLY_SOURCES owns that, so the resolver and this agree.
    crossComponent: true,
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


// `https://github.com/hazelcast-guides/istio.git` -> `hazelcast-guides/istio`
const originSlug = (url) => (url || '').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '') || null

// Clear what THIS component staged last run, read from its own previous
// manifest.
//
// Deliberately not a wipe of the staging dir: it is shared -- tutorials stages
// the guide repos' files there, operator stages code-samples' -- and a wipe by
// whichever component ran second would delete the other's bytes, leaving the
// converter unable to content-match them and silently baking those blocks again.
// Clearing by manifest also does the job the wipe was there for: a file the
// component no longer references is dropped, because it was in the old manifest
// and will not be in the new one.
function clearPreviouslyStaged (stagingDir, manifestFile, dry) {
  let prev
  try { prev = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { return }
  for (const f of prev.files || []) {
    if (!dry) fs.rmSync(path.join(stagingDir, f.id), { force: true })
  }
}

// One manifest row: where the build re-fetches the file from, and a hash of the
// exact bytes the converter content-matched against, so a page can never publish
// code the migration did not see. `content` is carried alongside for staging and
// dropped before the manifest is written.
const manifestEntry = (id, content, { origin, ref, sha, path: filePath }) => ({
  id,
  repo: originSlug(origin),
  ref,
  sha,
  path: filePath,
  sha256: crypto.createHash('sha256').update(content).digest('hex'),
  content,
})

// Write the staged bytes + the reference manifest for one component. Shared by
// the two modes that stage by reference (tutorials' multi, operator's cross-
// component templates) so they cannot disagree about the manifest's shape --
// plugins/tutorial-examples reads both.
function writeStaged (entries, { stagingDir, manifestFile, note, selectors = [], dry }) {
  entries.sort((a, b) => a.id.localeCompare(b.id))
  if (dry) return
  for (const e of entries) {
    const f = path.join(stagingDir, e.id)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, e.content)
  }
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  fs.writeFileSync(manifestFile, JSON.stringify({
    note,
    // Tag specs the pages ask for that cannot be enumerated from a file's own
    // markers (lists, negations). The converter's content index needs them to be
    // able to match those blocks at all.
    ...(selectors.length ? { selectors } : {}),
    files: entries.map(({ content, ...rest }) => rest),
  }, null, 2) + '\n')
}

// Every `example$` include the branch's pages make, as {component, module, rel}
// (usage mode).
//
// Scans EVERY module, not just ROOT. Operator has two -- its 7 tutorial pages
// live in `tutorials`, and a ROOT-only scan never saw their 58 includes at all:
// not misresolved, never looked up, so not even reported as missing.
//
// Keeps the coordinate rather than flattening to a path. The module is a
// directory level, so a bare `example$foo` in module `m` means
// `modules/m/examples/foo` and reading it as ROOT's finds nothing; and the
// COMPONENT decides which repo to open, which is the whole point for operator's
// `templates:` includes (hazelcast-code-samples, not the operator docs repo).
function referencedExamples (repoDir, ref, modulesDir) {
  let out
  try {
    out = execFileSync('git', ['-C', repoDir, 'grep', '-oE', 'include::[^[]*example\\$[^][]+', ref, '--', modulesDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return []
  }
  const seen = new Set()
  const refs = []
  for (const line of out.split('\n')) {
    // `<ref>:<path>:<match>` -- the path holds no colon, the match holds several.
    const m = /^[^:]*:([^:]+):(include::.*)$/.exec(line)
    if (!m) continue
    const pageModule = /modules\/([^/]+)\//.exec(m[1])
    const target = m[2].slice('include::'.length)
    const i = target.indexOf('example$')
    const rel = target.slice(i + 'example$'.length).replace(/^\/+/, '').trim()
    if (!rel) continue
    // What precedes `example$` is `[component:][module:]` -- the family itself is
    // already cut off, so the LAST remaining segment is the module and the one
    // before it the component. No segments at all means the page's own module.
    const parts = target.slice(0, i).split(':').filter(Boolean)
    const component = parts.length >= 2 ? parts[parts.length - 2] : null
    const module = parts.length >= 1 ? parts[parts.length - 1] : (pageModule ? pageModule[1] : 'ROOT')
    const key = `${component || ''}\u0000${module}\u0000${rel}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ component, module, rel })
  }
  return refs
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
    for (const m of txt.matchAll(/include::([^[]*example\$[^[]+)\[([^\]]*)\]/g)) {
      const i = m[1].indexOf('example$')
      const rel = m[1].slice(i + 'example$'.length).replace(/^\/+/, '').trim()
      if (!rel) continue
      // [component:][module:] -- the LAST coordinate is the module; none means ROOT.
      const parts = m[1].slice(0, i).split(':').filter(Boolean)
      // The SELECTOR matters as well as the file: a tag list or negation cannot be
      // guessed from the file's own markers, so the converter is told which ones
      // are actually asked for (see the manifest's `selectors`).
      const tm = (m[2] || '').match(/\btags?=([^,\]]+)/)
      out.push({ module: parts.length ? parts[parts.length - 1] : 'ROOT', rel, tag: tm ? tm[1].trim() : null })
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
  const manifestFile = path.join(outDirFor(opts.outRoot, opts.component, opts.versions[0]), 'examples.json')
  clearPreviouslyStaged(stagingDir, manifestFile, opts.dry)

  const sources = multiRepoSources(opts.playbookFile, opts.component, opts.sourcesDir)
  const staged = new Map()
  const entries = []
  const missing = []
  const selectors = new Set()
  let sites = 0
  let repos = 0

  for (const s of sources) {
    const refs = referencedExamplesByModule(s.repoDir, s.ref, `${s.startPath}/modules`)
    if (!refs.length) continue
    repos++
    for (const { module, rel, tag } of refs) {
      sites++
      if (tag && /[;,!]/.test(tag)) selectors.add(tag)
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
      entries.push(manifestEntry(id, raw, { origin: s.origin, ref: s.ref, sha: s.sha, path: real }))
    }
  }

  writeStaged(entries, {
    stagingDir,
    manifestFile,
    selectors: [...selectors].sort(),
    note: 'Generated by migration/extract-examples.js. Example files are NOT stored in this repo -- they are the guide repos\' runnable project files. plugins/tutorial-examples fetches each from `repo` at `sha` into the gitignored staging dir on every build.',
    dry: opts.dry,
  })

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

  const stagingDir = path.join(opts.outRoot, EXAMPLES_STAGING)
  const crossManifest = path.join(outDirFor(opts.outRoot, opts.component, opts.versions[0]), 'examples.json')
  if (cfg.crossComponent) clearPreviouslyStaged(stagingDir, crossManifest, opts.dry)
  // Cross-component files are the same bytes on every operator branch, so they are
  // collected across ALL versions into ONE manifest -- keyed by id, which carries
  // the source repo, so a second version contributing the same file is a no-op.
  const crossById = new Map()
  const crossSites = { total: 0, missing: [] }

  let total = 0
  for (const ver of opts.versions) {
    const ref = refFor(opts.component, ver.seg)
    const refs = tree
      ? allExampleFiles(repoDir, ref, cfg.examplesDir).map((rel) => ({ component: null, module: 'ROOT', rel }))
      : referencedExamples(repoDir, ref, cfg.modulesDir)
    const dir = outExamplesDir(opts.outRoot, opts.component, ver)

    // Tree mode owns the directory: clear it so an upstream deletion is not
    // preserved here as a stale file the converter could still content-match.
    if (tree && !opts.dry) fs.rmSync(dir, { recursive: true, force: true })

    let written = 0
    const missing = []
    for (const { component, module, rel } of refs) {
      if (component && component !== opts.component) {
        collectCrossComponent({ component, rel }, { opts, crossById, crossSites, cfg })
        continue
      }
      // Tree mode addresses its one examplesDir; usage mode addresses the module
      // the include named, which is a directory level in the path.
      const from = tree ? `${cfg.examplesDir}/${rel}` : `${cfg.modulesDir}/${module}/examples/${rel}`
      const raw = gitShow(repoDir, ref, from)
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

  if (cfg.crossComponent) {
    const entries = [...crossById.values()]
    writeStaged(entries, {
      stagingDir,
      manifestFile: crossManifest,
      note: 'Generated by migration/extract-examples.js. These example files are NOT stored in this repo -- they belong to another component (see `repo`), whose own CI builds and maintains them. plugins/tutorial-examples fetches each from `repo` at `sha` into the gitignored staging dir on every build. Shared by every version of this component: the source is not versioned per release.',
      dry: opts.dry,
    })
    console.log(`[extract-examples] ${opts.component} cross-component: ${entries.length} file(s), ${crossSites.total} include site(s)`)
    console.log(`[extract-examples]   manifest -> ${path.relative(process.cwd(), crossManifest)}`)
    console.log(`[extract-examples]   staged   -> ${path.relative(process.cwd(), stagingDir)} (gitignored, re-fetched on every site build)`)
    if (crossSites.missing.length) {
      console.error(`[extract-examples] ABORT: ${crossSites.missing.length} cross-component example(s) could not be read:\n  ${crossSites.missing.slice(0, 10).join('\n  ')}`)
      process.exit(1)
    }
  }
}

// Resolve one cross-component `example$` include and collect it for staging.
//
// The mirror is looked up in lib/layout's READ_ONLY_SOURCES rather than restated
// here, so this and refcheck's resolver can never disagree about which repo (or
// which branch) a component's files come from.
//
// The path always goes through resolveGitLinks: code-samples reaches these files
// via a symlinked first segment (`docs/modules/ROOT/examples/platform-operator`
// -> the repo root), which a plain `git show` cannot follow.
function collectCrossComponent ({ component, rel }, { opts, crossById, crossSites, cfg }) {
  const src = sourceMirrorFor(component)
  if (!src) return
  crossSites.total++
  const repoDir = path.join(opts.sourcesDir, src.repo)
  const from = `${src.modulesRoot}/ROOT/examples/${rel}`
  const real = resolveGitLinks(repoDir, src.ref, from)
  const raw = real == null ? null : gitShow(repoDir, src.ref, real)
  if (raw == null) { crossSites.missing.push(`${component}:${rel}`); return }
  // First segment is the source repo, matching how multi mode namespaces its ids
  // -- so two components staging into the shared dir cannot collide, even when
  // they reference byte-identical copies of the same file from different repos.
  const id = path.posix.join(src.repo.replace(/\.git$/, ''), real)
  if (crossById.has(id)) return
  crossById.set(id, manifestEntry(id, raw, {
    origin: gitConfig(repoDir, 'remote.origin.url'),
    ref: src.ref,
    sha: gitRevParse(repoDir, src.ref),
    path: real,
  }))
}

main()
