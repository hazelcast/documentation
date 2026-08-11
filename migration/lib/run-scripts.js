'use strict'

// Sequentially run a list of node scripts, forwarding `args` to each and running
// ALL of them regardless of individual outcome (no fail-fast). Prints a one-line
// summary and returns the count that failed, so the caller can set its exit code.
// Shared by the `check` (gates) and `selftest` (unit tests) umbrellas, both of
// which replaced `&&` npm-script chains that aborted on the first failure and
// could not forward a scope flag.

const path = require('node:path')
const { spawnSync } = require('node:child_process')

function runScripts (label, scripts, args, rootDir) {
  const results = []
  for (const s of scripts) {
    const res = spawnSync(process.execPath, [path.join(rootDir, s.script), ...args], { stdio: 'inherit' })
    // A spawn failure (status null) or a signal both count as a non-clean run.
    results.push({ name: s.name, code: res.status == null ? 2 : res.status })
  }
  const failed = results.filter((r) => r.code !== 0)
  const summary = results.map((r) => `${r.name}=${r.code === 0 ? 'ok' : 'FAIL(' + r.code + ')'}`).join('  ')
  console.error(`\n[${label}] ${args.length ? args.join(' ') + '  ' : ''}${summary}`)
  if (failed.length) {
    console.error(`[${label}] ${failed.length} of ${results.length} failed: ${failed.map((r) => r.name).join(', ')}`)
  } else {
    console.error(`[${label}] all ${results.length} clean. ✓`)
  }
  return failed.length
}

module.exports = { runScripts }
