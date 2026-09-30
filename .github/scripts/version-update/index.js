#!/usr/bin/env node
'use strict'

// Version update for a release. See MAINTAINING.md "Releasing a version".
//   node .github/scripts/version-update <component> <version> [--next V] [--hazelcast V] [--mc V] [--dry-run]
// With no component, reads the Platform release info get-release-info outputs as env vars (package.yml).

const fs = require('node:fs')
const path = require('node:path')
const {parseArgs} = require('node:util')
const {flagsFromEnv, planBump, planRelease} = require('./rules')
const {readState, applySteps} = require('./files')

function main () {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      'next': {type: 'string'},
      'hazelcast': {type: 'string'},
      'mc': {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
  })
  const siteDir = path.resolve(__dirname, '..', '..', '..')
  const state = readState(siteDir)
  let version
  let result
  if (positionals.length) {
    const [component, release] = positionals
    if (!release || positionals.length > 2) throw new Error('Usage: version-update <component> <version> [--next V] [--hazelcast V] [--mc V] [--dry-run]')
    version = release
    result = planRelease(component, release, {next: values.next, hazelcast: values.hazelcast, mc: values.mc}, state)
  } else {
    const flags = flagsFromEnv(process.env)
    version = flags.releaseVersion
    result = planBump(flags, state)
  }
  const {steps, notes} = result

  for (const note of notes) console.log(note)
  if (!steps.length) console.log(`Nothing to change for ${version}.`)
  else if (values['dry-run']) for (const step of steps) console.log(JSON.stringify(step))
  else for (const line of applySteps(siteDir, steps)) console.log(line)

  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes=${steps.length > 0}\n`)
}

try {
  main()
} catch (error) {
  console.error(`version-update: ${error.message}`)
  process.exit(1)
}
