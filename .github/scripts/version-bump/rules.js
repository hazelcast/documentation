'use strict'

// What a Platform release changes, as ops on the site's version state. Pure, so it can be tested without files.

const PLATFORM = 'hazelcast'
const MC = 'management-center'
const MC_HZ_VERSION = 'page-latest-supported-hazelcast'

const FLAG_NAMES = [
  'RELEASE_VERSION', 'REL_MAJOR_MINOR', 'MASTER_VERSION', 'MASTER_MAJOR_MINOR', 'MC_MAJOR_MINOR',
  'IS_PATCH_RELEASE', 'IS_REL_MAJOR_MINOR', 'IS_LATEST_STABLE_RELEASE', 'IS_BETA_RELEASE',
]

// The outputs of hazelcast/mono-actions/get-release-info.
function flagsFromEnv (env) {
  const missing = FLAG_NAMES.filter((name) => !env[name])
  if (missing.length) throw new Error(`Missing release info: ${missing.join(', ')}`)
  const bool = (name) => {
    if (env[name] !== 'true' && env[name] !== 'false') throw new Error(`${name} must be 'true' or 'false', got '${env[name]}'`)
    return env[name] === 'true'
  }
  return {
    releaseVersion: env.RELEASE_VERSION,
    relMajorMinor: env.REL_MAJOR_MINOR,
    masterVersion: env.MASTER_VERSION,
    masterMajorMinor: env.MASTER_MAJOR_MINOR,
    mcMajorMinor: env.MC_MAJOR_MINOR,
    isPatch: bool('IS_PATCH_RELEASE'),
    isMajorMinor: bool('IS_REL_MAJOR_MINOR'),
    isLatestStable: bool('IS_LATEST_STABLE_RELEASE'),
    isBeta: bool('IS_BETA_RELEASE'),
  }
}

function compareMajorMinor (a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number)
  const [bMajor, bMinor] = b.split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor
}

// state: {current: currentVersions.json, releases: <component>_versions.json, variables: versionedVariables}.
// Values that already hold are left out, so empty `ops` means nothing to commit.
function planBump (flags, state) {
  const ops = []
  const notes = []
  const setVars = (component, version, values) => {
    const existing = state.variables[component]?.[version]
    if (!existing) throw new Error(`src/variables.ts has no ${component} '${version}' entry`)
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => existing[k] !== v))
    if (Object.keys(changed).length) ops.push({op: 'setVars', component, version, values: changed})
    else notes.push(`${component} ${version}: already up to date`)
  }

  const {releaseVersion: version, relMajorMinor: rel} = flags
  if (flags.isBeta) throw new Error(`${version} is a beta release; beta releases are not supported`)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`RELEASE_VERSION '${version}' is not x.y.z`)
  if (!version.startsWith(`${rel}.`)) throw new Error(`REL_MAJOR_MINOR '${rel}' does not match RELEASE_VERSION '${version}'`)
  if (flags.isPatch === flags.isMajorMinor) {
    throw new Error(`${version} must be exactly one of a patch or a major/minor release`)
  }

  const platformReleases = state.releases[PLATFORM]
  const platformVars = state.variables[PLATFORM]

  if (flags.isPatch) {
    // As hz-docs: `os-version` stays at the line's .0; `minor-version`/`version` only where already present.
    if (!platformReleases.includes(rel)) {
      notes.push(`${PLATFORM} ${rel} is not a live version; skipping the Platform update`)
    } else {
      const values = {'full-version': version, 'ee-version': version}
      for (const key of ['minor-version', 'version']) {
        if (key in platformVars[rel]) values[key] = rel
      }
      setVars(PLATFORM, rel, values)
    }
    if (flags.isLatestStable) setVars(MC, flags.mcMajorMinor, {[MC_HZ_VERSION]: rel})
    return {ops, notes}
  }

  // The release is a copy of main, so it can only be main's line, and main moves to the product's next snapshot.
  const platform = state.current[PLATFORM]
  const mainLine = platform.currentSeg.replace(/-snapshot$/, '')
  if (rel !== mainLine) {
    throw new Error(`${version} is not the line main is on (${platform.currentSeg}); only main's line can be released from here`)
  }
  if (platformReleases.includes(rel)) throw new Error(`${PLATFORM} ${rel} has already been released`)
  const master = flags.masterMajorMinor
  if (flags.masterVersion !== `${master}.0-SNAPSHOT`) {
    throw new Error(`MASTER_VERSION '${flags.masterVersion}' does not match MASTER_MAJOR_MINOR '${master}'`)
  }
  if (compareMajorMinor(master, rel) <= 0) {
    throw new Error(`The product's master (${flags.masterVersion}) has not moved past ${rel} yet, so main has no next snapshot to move to`)
  }
  if (!flags.isLatestStable) throw new Error(`${version} is not the latest stable release`)

  const releaseVars = {...platformVars.current, 'full-version': version, 'ee-version': version, 'os-version': version}
  for (const key of ['minor-version', 'version']) {
    if (key in platformVars.current) releaseVars[key] = rel
  }
  ops.push({op: 'addRelease', component: PLATFORM, version: rel, fromSeg: platform.currentSeg, variables: releaseVars})

  const nextSeg = `${master}-snapshot`
  ops.push({op: 'setCurrent', component: PLATFORM, fromSeg: platform.currentSeg, currentSeg: nextSeg, currentLabel: `${master}-SNAPSHOT`})
  setVars(PLATFORM, 'current', {
    'full-version': flags.masterVersion,
    'ee-version': flags.masterVersion,
    'os-version': flags.masterVersion,
    'minor-version': `${master}-SNAPSHOT`,
    'version': `${master}-SNAPSHOT`,
  })
  ops.push({op: 'setLatestRedirects', component: PLATFORM, latest: rel, latestDev: nextSeg})

  setVars(MC, 'current', {[MC_HZ_VERSION]: nextSeg})
  setVars(MC, flags.mcMajorMinor, {[MC_HZ_VERSION]: rel})
  return {ops, notes}
}

// The effect of `ops` on `state`, without the file-level work.
function applyToState (state, ops) {
  const next = structuredClone(state)
  for (const op of ops) {
    if (op.op === 'setVars') {
      Object.assign(next.variables[op.component][op.version], op.values)
    } else if (op.op === 'addRelease') {
      next.releases[op.component] = [op.version, ...next.releases[op.component]]
      const {current, ...rest} = next.variables[op.component]
      next.variables[op.component] = {current, [op.version]: {...op.variables}, ...rest}
    } else if (op.op === 'setCurrent') {
      Object.assign(next.current[op.component], {currentSeg: op.currentSeg, currentLabel: op.currentLabel})
    }
  }
  return next
}

module.exports = {flagsFromEnv, planBump, applyToState, compareMajorMinor, PLATFORM, MC}
