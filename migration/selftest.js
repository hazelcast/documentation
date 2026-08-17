'use strict'

// Umbrella for the unit-test suites of the pure logic the gates and converter
// depend on (needs no golden/build). Like check.js, replaces an `&&` chain that
// aborted on the first failure: runs ALL suites regardless of outcome, so one
// broken suite no longer hides the others, then exits non-zero if any failed.
//
//   node selftest.js
//
// Each suite's exit code is its verdict: 0 pass, non-zero fail.

const { runScripts } = require('./lib/run-scripts')

const SUITES = [
  { name: 'layout', script: 'lib/selftest.js' },
  { name: 'accepted', script: 'lib/accepted-selftest.js' },
  { name: 'converter', script: 'converter/selftest.js' },
  { name: 'fidelity', script: 'fidelity/selftest.js' },
  { name: 'refs', script: 'refcheck/selftest.js' },
  { name: 'constructs', script: 'constructcheck/selftest.js' },
  { name: 'orphans', script: 'orphancheck/selftest.js' },
]

process.exit(runScripts('selftest', SUITES, process.argv.slice(2), __dirname) ? 1 : 0)
