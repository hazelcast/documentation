#!/usr/bin/env node
'use strict'

// Applies a change made in one version's folder to other versions of the same product. See CONTRIBUTING.md "Changing content for several versions".
//   npm run backport -- <version>... [--from <version>] [--commit <ref>] [--dry-run]
// Exit status: 0 when every file applied cleanly, 1 when a file needs attention, 2 when nothing was done.

const path = require('node:path')
const {parseArgs} = require('node:util')
const {backport} = require('./apply')

const USAGE = 'Usage: npm run backport -- <version>... [--from <version>] [--commit <ref>] [--dry-run]'

function main () {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      'from': {type: 'string'},
      'commit': {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
  })
  if (!positionals.length) throw new Error(USAGE)
  const siteDir = path.resolve(__dirname, '..', '..')
  const dryRun = values['dry-run']
  const {results, ignored, notes} = backport(siteDir, {targets: positionals, from: values.from, commit: values.commit, dryRun})

  if (dryRun) console.log('Dry run: no files were changed.')
  let attention = false
  for (const job of results) {
    console.log(`${job.product} ${job.fromSeg} -> ${job.toSeg}`)
    for (const {outcome, file, detail} of job.files) {
      if (outcome !== 'applied' && outcome !== 'unchanged') attention = true
      console.log(`  ${outcome.padEnd(11)} ${file}${detail ? ` (${detail})` : ''}`)
    }
  }
  for (const note of notes) console.log(note)
  if (ignored.length) console.log(`Not in a version's folder, so left alone: ${ignored.join(', ')}`)
  if (attention) {
    console.log('Resolve each conflict (the <<<<<<< markers), and make the change by hand to each file that was not applied or is missing.')
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  console.error(`backport: ${error.message}`)
  process.exitCode = 2
}
