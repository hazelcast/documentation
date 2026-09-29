#!/usr/bin/env node
'use strict'

// Version bump for a Platform release. Reads the get-release-info outputs as env vars (see .github/workflows/package.yml):
//   RELEASE_VERSION=5.7.2 REL_MAJOR_MINOR=5.7 MASTER_VERSION=6.0.0-SNAPSHOT MASTER_MAJOR_MINOR=6.0 MC_MAJOR_MINOR=5.11 \
//   IS_PATCH_RELEASE=true IS_REL_MAJOR_MINOR=false IS_LATEST_STABLE_RELEASE=true IS_BETA_RELEASE=false \
//   node .github/scripts/version-bump [--dry-run]

const fs = require('node:fs')
const path = require('node:path')
const {flagsFromEnv, planBump} = require('./rules')
const {readState, applyOps} = require('./files')

function main () {
  const dryRun = process.argv.includes('--dry-run')
  const siteDir = path.resolve(__dirname, '..', '..', '..')
  const flags = flagsFromEnv(process.env)
  const {ops, notes} = planBump(flags, readState(siteDir))

  for (const note of notes) console.log(note)
  if (!ops.length) console.log(`Nothing to change for ${flags.releaseVersion}.`)
  else if (dryRun) for (const op of ops) console.log(JSON.stringify(op))
  else for (const line of applyOps(siteDir, ops)) console.log(line)

  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes=${ops.length > 0}\n`)
}

try {
  main()
} catch (error) {
  console.error(`version-bump: ${error.message}`)
  process.exit(1)
}
