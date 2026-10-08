'use strict'

// Works out what a release changes, as a list of steps for files.js to carry out. It reads no files, so the rules can be tested on their own.

const PLATFORM = 'hazelcast'
const MC = 'management-center'
const OPERATOR = 'operator'
const CLC = 'clc'
const MC_HZ_VERSION = 'page-latest-supported-hazelcast'
const HZ_MC_VERSION = 'page-latest-supported-mc'

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

function compareVersions (a, b) {
  const as = a.split('.').map(Number)
  const bs = b.split('.').map(Number)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if ((as[i] ?? 0) !== (bs[i] ?? 0)) return (as[i] ?? 0) - (bs[i] ?? 0)
  }
  return 0
}

const compareMajorMinor = (a, b) => compareVersions(a.split('.').slice(0, 2).join('.'), b.split('.').slice(0, 2).join('.'))
const majorMinor = (version) => version.split('.').slice(0, 2).join('.')

function parseRelease (version) {
  if (/-BETA-\d+$/i.test(version)) throw new Error(`${version} is a beta release; beta releases are not supported`)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`'${version}' is not x.y.z`)
  const [major, minor, patch] = version.split('.').map(Number)
  return {version, majorMinor: `${major}.${minor}`, isPatch: patch > 0}
}

// Collects steps against `state`, leaving out values that already hold.
function plan (state) {
  const steps = []
  const notes = []
  const setVars = (component, version, values) => {
    const existing = state.variables[component]?.[version]
    if (!existing) throw new Error(`src/variables.ts has no ${component} '${version}' entry`)
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && existing[k] !== v))
    if (Object.keys(changed).length) steps.push({step: 'setVars', component, version, values: changed})
    else notes.push(`${component} ${version}: already up to date`)
  }
  return {steps, notes, setVars}
}

// state: {current: currentVersions.json, releases: <component>_versions.json, variables: versionedVariables, redirects}.
// Values that already hold are left out, so empty `steps` means nothing to commit.
function planBump (flags, state) {
  const {steps, notes, setVars} = plan(state)

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
    return {steps, notes}
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
  steps.push({step: 'addRelease', component: PLATFORM, version: rel, fromSeg: platform.currentSeg, variables: releaseVars})

  const nextSeg = `${master}-snapshot`
  steps.push({step: 'setCurrent', component: PLATFORM, fromSeg: platform.currentSeg, currentSeg: nextSeg, currentLabel: `${master}-SNAPSHOT`})
  setVars(PLATFORM, 'current', {
    'full-version': flags.masterVersion,
    'ee-version': flags.masterVersion,
    'os-version': flags.masterVersion,
    'minor-version': `${master}-SNAPSHOT`,
    'version': `${master}-SNAPSHOT`,
  })
  steps.push({step: 'setLatestRedirects', component: PLATFORM, latest: rel, latestDev: nextSeg})
  steps.push({step: 'dropPlaceholders', component: PLATFORM, segs: [rel, nextSeg]})

  setVars(MC, 'current', {[MC_HZ_VERSION]: nextSeg})
  setVars(MC, flags.mcMajorMinor, {[MC_HZ_VERSION]: rel})
  return {steps, notes}
}

// A release run by hand or by a product's own workflow. options: {next, hazelcast, mc} as each product needs.
function planRelease (component, version, options, state) {
  const release = parseRelease(version)
  if (component === PLATFORM) return planBump(platformFlags(release, options, state), state)
  if (component === MC) return planManagementCenter(release, options, state)
  if (component === OPERATOR) return planOperator(release, options, state)
  if (component === CLC) return planClc(release, state)
  throw new Error(`Unknown component '${component}'; expected one of ${[PLATFORM, MC, OPERATOR, CLC].join(', ')}`)
}

function nextSnapshot (release, next, component) {
  if (!next) throw new Error(`A ${component} ${release.version} release needs --next, the version main moves to (e.g. X.Y.0-SNAPSHOT)`)
  const nextVersion = next.replace(/-SNAPSHOT$/i, '')
  if (!/^\d+\.\d+\.0$/.test(nextVersion)) throw new Error(`--next '${next}' is not x.y.0 or x.y.0-SNAPSHOT`)
  const nextLine = majorMinor(nextVersion)
  if (compareMajorMinor(nextLine, release.majorMinor) <= 0) throw new Error(`--next ${next} is not after ${release.version}`)
  return nextLine
}

// The same flags get-release-info derives, from the site's own state: master comes from --next.
function platformFlags (release, {next}, state) {
  const newest = state.releases[PLATFORM][0]
  const masterLine = release.isPatch ? state.current[PLATFORM].currentSeg.replace(/-snapshot$/, '') : nextSnapshot(release, next, PLATFORM)
  return {
    releaseVersion: release.version,
    relMajorMinor: release.majorMinor,
    masterVersion: `${masterLine}.0-SNAPSHOT`,
    masterMajorMinor: masterLine,
    mcMajorMinor: state.releases[MC][0],
    isPatch: release.isPatch,
    isMajorMinor: !release.isPatch,
    isLatestStable: !newest || compareMajorMinor(release.majorMinor, newest) >= 0,
    isBeta: false,
  }
}

// As management-center's update_mc_docs/update_hz_docs/update_hazelcast_docs workflows, plus the
// per-patch release-notes alias the downloads page links to and the swagger branch.
function planManagementCenter (release, {next}, state) {
  const {steps, notes, setVars} = plan(state)
  const {version, majorMinor: line} = release
  const releaseNotes = (seg) => `/${MC}/${seg}/release-notes/release-notes`
  const alias = () => {
    const from = `/${MC}/${line}/release-notes/${version.replace(/\./g, '-')}`
    if ((state.redirects ?? []).some((entry) => entry.from === from)) notes.push(`${from}: alias already exists`)
    else steps.push({step: 'addAlias', component: MC, version: line, from, to: releaseNotes(line)})
  }
  const pointPlatformAt = (mcVars) => {
    const platformVersion = mcVars[MC_HZ_VERSION]
    if (state.releases[PLATFORM].includes(platformVersion)) setVars(PLATFORM, platformVersion, {[HZ_MC_VERSION]: line})
    else notes.push(`${PLATFORM} '${platformVersion}' is not a release; skipping its ${HZ_MC_VERSION}`)
  }

  if (release.isPatch) {
    if (!state.releases[MC].includes(line)) {
      notes.push(`${MC} ${line} is not a live version; nothing to change`)
      return {steps, notes}
    }
    setVars(MC, line, {'full-version': version, 'mc-repo-swagger-branch': version})
    alias()
    pointPlatformAt(state.variables[MC][line])
    return {steps, notes}
  }

  const current = state.current[MC]
  const mainLine = current.currentSeg.replace(/-snapshot$/, '')
  if (line !== mainLine) throw new Error(`${version} is not the line main is on (${current.currentSeg})`)
  if (state.releases[MC].includes(line)) throw new Error(`${MC} ${line} has already been released`)
  const nextLine = nextSnapshot(release, next, MC)
  const nextSeg = `${nextLine}-snapshot`
  // Main supports the Platform snapshot; a release supports the newest Platform release.
  const mainPlatform = state.variables[MC].current[MC_HZ_VERSION]
  const releasePlatform = state.releases[PLATFORM].includes(mainPlatform) ? mainPlatform : state.releases[PLATFORM][0]
  const releaseVars = {...state.variables[MC].current, 'full-version': version, 'mc-repo-swagger-branch': version, [MC_HZ_VERSION]: releasePlatform}
  steps.push({step: 'addRelease', component: MC, version: line, fromSeg: current.currentSeg, variables: releaseVars})
  steps.push({step: 'setCurrent', component: MC, fromSeg: current.currentSeg, currentSeg: nextSeg, currentLabel: `${nextLine}-SNAPSHOT`})
  setVars(MC, 'current', {'full-version': `${nextLine}.0-SNAPSHOT`})
  steps.push({step: 'setLatestRedirects', component: MC, latest: line, latestDev: nextSeg})
  steps.push({step: 'dropPlaceholders', component: MC, segs: [line, nextSeg]})
  alias()
  setVars(PLATFORM, 'current', {[HZ_MC_VERSION]: nextSeg})
  pointPlatformAt(releaseVars)
  return {steps, notes}
}

// As hazelcast-platform-operator's docs-release workflow, except that a release of an existing line can leave out
// --next: the upcoming release has not changed, so main's chart version stays. Main is always `latest-snapshot`.
function planOperator (release, {next, hazelcast, mc}, state) {
  const {steps, notes, setVars} = plan(state)
  const {version, majorMinor: line} = release
  if (next) {
    parseRelease(next)
    if (compareVersions(next, version) <= 0) throw new Error(`--next ${next} is not after ${version}`)
  }
  const supported = {[MC_HZ_VERSION]: hazelcast, [HZ_MC_VERSION]: mc}
  const releaseValues = {'operator-chart-version': version, ...supported}

  if (state.releases[OPERATOR].includes(line)) {
    setVars(OPERATOR, line, releaseValues)
  } else {
    const newest = state.releases[OPERATOR][0]
    if (newest && compareMajorMinor(line, newest) <= 0) {
      notes.push(`${OPERATOR} ${line} is not a live version; nothing to change`)
      return {steps, notes}
    }
    if (!next) throw new Error(`A new ${OPERATOR} line needs --next, the upcoming release (x.y.z)`)
    const current = state.current[OPERATOR]
    const variables = {...state.variables[OPERATOR].current}
    for (const [k, v] of Object.entries(releaseValues)) if (v !== undefined) variables[k] = v
    steps.push({step: 'addRelease', component: OPERATOR, version: line, fromSeg: current.currentSeg, variables})
    steps.push({step: 'setLatestRedirects', component: OPERATOR, latest: line})
    steps.push({step: 'dropPlaceholders', component: OPERATOR, segs: [line]})
  }
  setVars(OPERATOR, 'current', {'operator-chart-version': next ? `${next}-snapshot` : undefined, ...supported})
  return {steps, notes}
}

// CLC's main IS its newest release, so a release freezes main as the outgoing version and renames main.
function planClc (release, state) {
  const {steps, notes, setVars} = plan(state)
  const {version} = release
  const outgoing = state.current[CLC].currentSeg
  if (compareVersions(version, outgoing) <= 0) throw new Error(`${CLC} ${version} is not after the current version, ${outgoing}`)
  if (state.releases[CLC].includes(version)) throw new Error(`${CLC} ${version} has already been released`)
  steps.push({step: 'addRelease', component: CLC, version: outgoing, fromSeg: outgoing, variables: {...state.variables[CLC].current}})
  steps.push({step: 'setCurrent', component: CLC, fromSeg: outgoing, currentSeg: version, keepOld: true})
  setVars(CLC, 'current', {'full-version': version})
  steps.push({step: 'setLatestRedirects', component: CLC, latest: version})
  steps.push({step: 'dropPlaceholders', component: CLC, segs: [version]})
  return {steps, notes}
}

// The effect of `steps` on `state`, without the file-level work.
function applyToState (state, steps) {
  const next = structuredClone(state)
  for (const step of steps) {
    if (step.step === 'setVars') {
      Object.assign(next.variables[step.component][step.version], step.values)
    } else if (step.step === 'addRelease') {
      next.releases[step.component] = [step.version, ...next.releases[step.component]]
      const {current, ...rest} = next.variables[step.component]
      next.variables[step.component] = {current, [step.version]: {...step.variables}, ...rest}
    } else if (step.step === 'setCurrent') {
      next.current[step.component] = withCurrent(next.current[step.component], step)
    }
  }
  return next
}

// A label equal to the segment is left out, as currentVersions.json does.
function withCurrent (entry, {currentSeg, currentLabel}) {
  const {currentLabel: _, ...rest} = {...entry, currentSeg}
  return currentLabel && currentLabel !== currentSeg ? {currentSeg, currentLabel, ...rest} : rest
}

module.exports = {flagsFromEnv, planBump, planRelease, applyToState, withCurrent, compareVersions, PLATFORM, MC, OPERATOR, CLC}
