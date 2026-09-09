'use strict'

// Reading files out of a bare mirror when the path runs THROUGH a git symlink.
//
// Antora walks a worktree, so a symlinked directory is transparent to it. `git
// show` is not: on the symlink itself it returns the LINK TEXT, and on a path
// through one it fails outright. Both callers need the worktree behaviour --
// hazelcast-code-samples symlinks `docs/modules/ROOT/examples/platform-operator`
// to the repo root, and the guide repos symlink `src/`, `client/` and friends
// into their examples dir -- so the walk lives here once rather than in each.

const path = require('node:path')
const { execFileSync } = require('node:child_process')

// stderr silenced: a miss is signalled by the null return, and callers probe
// paths that are legitimately absent (a partial not present on an older branch).
function gitShow (repoDir, ref, file) {
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `${ref}:${file}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

// Memo of each PREFIX's resolution, not each whole path: every file under a
// symlinked directory re-walks the same leading segments, and each segment is a
// `git ls-tree` process. Operator's 51 code-samples examples all sit under
// `docs/modules/ROOT/examples/platform-operator`, so without this the same five
// segments are resolved 51 times over -- 126ms per file, most of it repeat work.
// Safe for the life of a process because the mirrors are frozen for the life of a
// run (same assumption as refcheck's textCache; see migration/README).
const prefixCache = new Map()

// Resolve `p` one segment at a time, following any segment that is a git symlink
// (mode 120000), as Antora does when it walks the worktree. Returns the real
// in-repo path, or null if a segment dead-ends. The hop limit catches a symlink
// cycle, which would otherwise spin here forever.
function resolveGitLinks (repoDir, ref, p) {
  let cur = ''
  for (const seg of p.split('/')) {
    const from = cur ? `${cur}/${seg}` : seg
    const key = `${repoDir}\u0000${ref}\u0000${from}`
    if (prefixCache.has(key)) {
      cur = prefixCache.get(key)
      if (cur === null) return null
      continue
    }
    cur = from
    let dead = false
    for (let hops = 0; ; hops++) {
      if (hops > 10) { dead = true; break }
      let entry
      try {
        entry = execFileSync('git', ['-C', repoDir, 'ls-tree', ref, '--', cur], { encoding: 'utf8' })
      } catch {
        dead = true
        break
      }
      if (!entry.startsWith('120000')) break
      const target = gitShow(repoDir, ref, cur)
      if (target == null) { dead = true; break }
      cur = path.posix.normalize(path.posix.join(path.posix.dirname(cur), target.trim()))
    }
    prefixCache.set(key, dead ? null : cur)
    if (dead) return null
  }
  return cur
}

// Read a file whose path may run through symlinks.
//
// NOT "try the direct read, fall back to the walk": `git show` on a symlink
// SUCCEEDS and hands back the link text, so a file that is itself a link would
// read as `../../../../pom.xml` -- a plausible-looking body, silently wrong. So
// ask what the full path IS first; only a real blob can be read directly, and
// everything else goes segment by segment.
function gitShowThroughLinks (repoDir, ref, file) {
  let entry = ''
  try {
    entry = execFileSync('git', ['-C', repoDir, 'ls-tree', ref, '--', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
  if (/^100\d{3} blob/.test(entry)) return gitShow(repoDir, ref, file)
  const real = resolveGitLinks(repoDir, ref, file)
  return real == null ? null : gitShow(repoDir, ref, real)
}

module.exports = { gitShow, resolveGitLinks, gitShowThroughLinks }
