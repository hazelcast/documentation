'use strict'

// Carries out a backport plan on a checkout: a three-way merge of each changed file into the same file in each target version.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync, spawnSync} = require('node:child_process')
const {planBackport, rewriter} = require('./plan')

const git = (siteDir, args, env) => execFileSync('git', args, {cwd: siteDir, maxBuffer: 1 << 30, env})
const lines = (buffer) => buffer.toString().split('\0').filter(Boolean)
const isBinary = (buffer) => buffer.includes(0)

function readState (siteDir) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(siteDir, file), 'utf8'))
  const current = read('src/currentVersions.json')
  const releases = Object.fromEntries(Object.keys(current).map((product) => [product, read(`${product}_versions.json`)]))
  return {current, releases}
}

function parseNameStatus (buffer) {
  const tokens = lines(buffer)
  const changes = []
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++][0]
    if (status === 'R') changes.push({status, oldPath: tokens[i++], path: tokens[i++]})
    else if (status === 'C') changes.push({status: 'A', path: (i++, tokens[i++])})
    else if (status === 'A' || status === 'M' || status === 'D') changes.push({status, path: tokens[i++]})
    else if (status === 'T') changes.push({status: 'M', path: tokens[i++]})
    else throw new Error(`${tokens[i]} is unmerged; finish the merge first`)
  }
  return changes
}

const DIFF = ['--no-color', '--no-ext-diff', '--name-status', '-z', '-M']

// The files a commit changes, or, without one, the uncommitted changes including new files.
// Uncommitted changes are staged into a copy of the index, so that git also detects a rename to a new, untracked file.
function listChanges (siteDir, commit) {
  if (commit) return parseNameStatus(git(siteDir, ['diff', ...DIFF, `${commit}^`, commit, '--']))
  const [unmerged] = lines(git(siteDir, ['ls-files', '-z', '--unmerged']))
  if (unmerged) throw new Error(`${unmerged.split('\t')[1]} is unmerged; finish the merge first`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backport-index-'))
  try {
    const index = path.join(dir, 'index')
    fs.copyFileSync(path.resolve(siteDir, git(siteDir, ['rev-parse', '--git-path', 'index']).toString().trim()), index)
    const env = {...process.env, GIT_INDEX_FILE: index}
    git(siteDir, ['add', '-A'], env)
    return parseNameStatus(git(siteDir, ['diff', '--cached', ...DIFF, 'HEAD', '--'], env))
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
}

function sourceContents (siteDir, commit) {
  const blob = (rev, file) => git(siteDir, ['cat-file', 'blob', `${rev}:${file}`])
  return {
    before: (file) => blob(commit ? `${commit}^` : 'HEAD', file),
    after: (file) => (commit ? blob(commit, file) : fs.readFileSync(path.join(siteDir, file))),
  }
}

function merge (ours, base, theirs, labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backport-'))
  try {
    const files = Object.entries({ours, base, theirs}).map(([name, content]) => {
      fs.writeFileSync(path.join(dir, name), content)
      return path.join(dir, name)
    })
    const result = spawnSync('git', ['merge-file', '-p', ...labels.flatMap((label) => ['-L', label]), ...files], {maxBuffer: 1 << 30})
    if (result.status === null || result.status > 127) throw new Error(`git merge-file failed: ${result.stderr}`)
    return {content: result.stdout, conflicts: result.status}
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
}

// Outcomes: applied, unchanged (already there), conflict (markers written), not applied (with a reason), missing (no such file in the target).
function applyFile (siteDir, job, file, contents, rewrite, dryRun) {
  const abs = (p) => path.join(siteDir, p)
  const exists = (p) => fs.existsSync(abs(p))
  const read = (p) => fs.readFileSync(abs(p))
  const rewritten = (p, buffer) => (isBinary(buffer) ? buffer : Buffer.from(rewrite(p, buffer.toString('utf8'))))
  const write = (p, content) => {
    if (dryRun) return
    fs.mkdirSync(path.dirname(abs(p)), {recursive: true})
    fs.writeFileSync(abs(p), content)
  }
  const remove = (p) => {
    if (dryRun) return
    fs.rmSync(abs(p))
    for (let dir = path.dirname(abs(p)); dir !== siteDir && !fs.readdirSync(dir).length; dir = path.dirname(dir)) fs.rmdirSync(dir)
  }
  const result = (outcome, detail) => ({outcome, file: file.target, detail})

  if (file.status === 'A') {
    const theirs = rewritten(file.source, contents.after(file.source))
    if (!exists(file.target)) return write(file.target, theirs), result('applied')
    if (read(file.target).equals(theirs)) return result('unchanged')
    return result('not applied', `already exists in ${job.toSeg} with different content`)
  }

  if (file.status === 'D') {
    if (!exists(file.target)) return result('unchanged')
    if (!read(file.target).equals(rewritten(file.source, contents.before(file.source)))) {
      return result('not applied', `differs from the ${job.fromSeg} copy, so it was not deleted`)
    }
    return remove(file.target), result('applied')
  }

  const oldTarget = file.targetOld ?? file.target
  const oldSource = file.sourceOld ?? file.source
  if (!exists(oldTarget)) return {outcome: 'missing', file: oldTarget, detail: `no such file in ${job.toSeg}`}
  if (file.status === 'R' && exists(file.target)) return result('not applied', `${file.target} already exists`)
  const ours = read(oldTarget)
  const base = rewritten(oldSource, contents.before(oldSource))
  const theirs = rewritten(file.source, contents.after(file.source))

  let merged
  if ([ours, base, theirs].some(isBinary)) {
    if (ours.equals(theirs) || ours.equals(base)) merged = {content: theirs, conflicts: 0}
    else return result('not applied', `binary file differs in ${job.toSeg}`)
  } else {
    merged = merge(ours, base, theirs, [job.toSeg, 'before', job.fromSeg])
  }
  if (file.status === 'R') {
    write(file.target, merged.content)
    remove(oldTarget)
  } else if (!merged.content.equals(ours)) {
    write(file.target, merged.content)
  } else {
    return result('unchanged')
  }
  if (merged.conflicts) return result('conflict', `${merged.conflicts} conflict${merged.conflicts > 1 ? 's' : ''}`)
  return result('applied')
}

// options: {targets: [version names], from, commit, dryRun}.
function backport (siteDir, {targets, from, commit, dryRun = false}) {
  const state = readState(siteDir)
  const changes = listChanges(siteDir, commit)
  if (!changes.length) throw new Error(commit ? `${commit} changes no files` : 'There are no uncommitted changes. Use --commit to apply a commit.')
  const {jobs, ignored, notes} = planBackport(state, changes, {targets, from})
  const contents = sourceContents(siteDir, commit)
  const results = jobs.map((job) => {
    const rewrite = rewriter(state, job.product, job.from, job.to)
    return {...job, files: job.files.map((file) => applyFile(siteDir, job, file, contents, rewrite, dryRun))}
  })
  return {results, ignored, notes}
}

module.exports = {backport}
