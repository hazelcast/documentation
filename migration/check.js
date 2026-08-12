'use strict'

// Umbrella for the three migration gates (fidelity, refs, constructs). Replaces
// the old `&&` npm-script chain, which had two defects: it fail-fast aborted on
// the first gate's findings (so a failure in one gate hid the others' results),
// and it could not forward a scope flag -- npm appends passthrough args only to
// the LAST command in a chain, and without a `--` separator npm swallows them
// entirely, so `npm run check -- --component cloud` silently ran all three gates
// UNSCOPED across every component.
//
// This runner forwards its own args to EVERY gate and runs ALL of them
// regardless of individual outcome, then exits non-zero if any gate failed.
// Scope the whole set with the same flags the gates accept:
//
//   node check.js [--component cloud|operator] [--id /url] [--json] ...
//
// A gate's exit code is its verdict: 0 clean, 1 findings, 2 bad invocation.

const { runScripts } = require('./lib/run-scripts')

const GATES = [
  { name: 'fidelity', script: 'fidelity/run.js' },
  { name: 'refs', script: 'refcheck/run.js' },
  { name: 'constructs', script: 'constructcheck/run.js' },
  { name: 'orphans', script: 'orphancheck/run.js' },
]

process.exit(runScripts('check', GATES, process.argv.slice(2), __dirname) ? 1 : 0)
