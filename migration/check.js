'use strict'

// Umbrella for the three migration gates (fidelity, refs, constructs). Replaces
// the old `&&` npm-script chain, which had two defects: it fail-fast aborted on
// the first gate's findings (so a failure in one gate hid the others' results),
// and it could not forward a scope flag -- npm appends passthrough args only to
// the LAST command in a chain, and without a `--` separator npm swallows them
// entirely, so `npm run check -- --component cloud` silently ran all three gates
// UNSCOPED across every component.
//
// This runner instead forwards its own args to EVERY gate and runs ALL of them
// regardless of individual outcome, then prints a summary and exits non-zero if
// any gate failed. Scope the whole set with the same flags the gates accept:
//
//   node check.js [--component cloud|operator] [--id /url] [--json] ...
//
// A gate's exit code is its verdict: 0 clean, 1 findings, 2 bad invocation.

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const GATES = [
  { name: 'fidelity', script: 'fidelity/run.js' },
  { name: 'refs', script: 'refcheck/run.js' },
  { name: 'constructs', script: 'constructcheck/run.js' },
]

function main () {
  const forwarded = process.argv.slice(2)
  const results = []

  for (const gate of GATES) {
    const scriptPath = path.join(__dirname, gate.script)
    const res = spawnSync(process.execPath, [scriptPath, ...forwarded], { stdio: 'inherit' })
    // A spawn failure (res.error) or a signal both count as a non-clean run.
    const code = res.status == null ? 2 : res.status
    results.push({ name: gate.name, code })
  }

  const failed = results.filter((r) => r.code !== 0)
  const summary = results.map((r) => `${r.name}=${r.code === 0 ? 'ok' : 'FAIL(' + r.code + ')'}`).join('  ')
  console.error(`\n[check] ${forwarded.length ? forwarded.join(' ') + '  ' : ''}${summary}`)
  if (failed.length) {
    console.error(`[check] ${failed.length} of ${results.length} gate(s) failed: ${failed.map((r) => r.name).join(', ')}`)
  } else {
    console.error(`[check] all ${results.length} gates clean. ✓`)
  }
  process.exit(failed.length ? 1 : 0)
}

main()
