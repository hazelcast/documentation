'use strict'

// Platform values first taken from the Antora updaters (hz-docs fe60348, management-center-docs dab0ba8); MC and
// Operator from their product repos' docs workflows (update_mc_docs/update_hz_docs, docs-release).

const test = require('node:test')
const assert = require('node:assert/strict')
const {flagsFromEnv, planBump, planRelease, applyToState, PLATFORM, MC, OPERATOR, CLC} = require('../rules')

const base = () => ({
  current: {
    [PLATFORM]: {currentSeg: '6.0-snapshot', currentLabel: '6.0-SNAPSHOT', defaultVersion: 'latest-release'},
    [MC]: {currentSeg: '5.12-snapshot', currentLabel: '5.12-SNAPSHOT', defaultVersion: 'latest-release'},
    [OPERATOR]: {currentSeg: 'latest-snapshot', defaultVersion: 'latest-release'},
    [CLC]: {currentSeg: '5.5.1', defaultVersion: 'current'},
  },
  releases: {[PLATFORM]: ['5.7', '5.6'], [MC]: ['5.11'], [OPERATOR]: ['5.19', '5.18'], [CLC]: ['5.5.0']},
  redirects: [{from: '/management-center/5.11/release-notes/5-11-0', to: '/management-center/5.11/release-notes/release-notes'}],
  variables: {
    [PLATFORM]: {
      current: {'full-version': '6.0.0-SNAPSHOT', 'os-version': '6.0.0-SNAPSHOT', 'ee-version': '6.0.0-SNAPSHOT',
        'minor-version': '6.0-SNAPSHOT', 'version': '6.0-SNAPSHOT', 'page-latest-supported-mc': '5.12-snapshot'},
      '5.7': {'full-version': '5.7.1', 'os-version': '5.7.0', 'ee-version': '5.7.1',
        'minor-version': '5.7', 'version': '5.7', 'page-latest-supported-mc': '5.11'},
      '5.6': {'full-version': '5.6.2', 'os-version': '5.6.0', 'ee-version': '5.6.2',
        'minor-version': '5.6', 'version': '5.6', 'page-latest-supported-mc': '5.10'},
    },
    [MC]: {
      current: {'full-version': '5.12.0-SNAPSHOT', 'mc-repo-swagger-branch': 'master', 'page-latest-supported-hazelcast': '6.0-snapshot'},
      '5.11': {'full-version': '5.11.1', 'mc-repo-swagger-branch': '5.11.1', 'page-latest-supported-hazelcast': '5.7'},
    },
    [OPERATOR]: {
      current: {'operator-chart-version': '5.20.0-snapshot', 'page-latest-supported-hazelcast': '5.7.1', 'page-latest-supported-mc': '5.11.1'},
      '5.19': {'operator-chart-version': '5.19.0', 'page-latest-supported-hazelcast': '5.7.1', 'page-latest-supported-mc': '5.11.1'},
      '5.18': {'operator-chart-version': '5.18.0', 'page-latest-supported-hazelcast': '5.7.0', 'page-latest-supported-mc': '5.11.0'},
    },
    [CLC]: {
      current: {'full-version': '5.5.1', 'page-latest-supported-mc': '5.8'},
      '5.5.0': {'full-version': '5.5.0', 'page-latest-supported-mc': '5.6'},
    },
  },
})

const flags = (overrides) => flagsFromEnv({
  RELEASE_VERSION: '6.0.0', REL_MAJOR_MINOR: '6.0', MASTER_VERSION: '6.1.0-SNAPSHOT', MASTER_MAJOR_MINOR: '6.1',
  MC_MAJOR_MINOR: '5.11', IS_PATCH_RELEASE: 'false', IS_REL_MAJOR_MINOR: 'true', IS_LATEST_STABLE_RELEASE: 'true',
  IS_BETA_RELEASE: 'false', ...overrides,
})
const patch = (version, latest) => flags({
  RELEASE_VERSION: version, REL_MAJOR_MINOR: version.split('.').slice(0, 2).join('.'), MASTER_VERSION: '6.0.0-SNAPSHOT',
  MASTER_MAJOR_MINOR: '6.0', IS_PATCH_RELEASE: 'true', IS_REL_MAJOR_MINOR: 'false', IS_LATEST_STABLE_RELEASE: String(latest),
})

const bump = (releaseFlags, state = base()) => applyToState(state, planBump(releaseFlags, state).steps)

test('a patch of the latest line sets full-version and ee-version, and leaves os-version', () => {
  const expected = base()
  Object.assign(expected.variables[PLATFORM]['5.7'], {'full-version': '5.7.2', 'ee-version': '5.7.2'})
  assert.deepEqual(bump(patch('5.7.2', true)), expected)
})

test('a patch of the latest line points MC at that line', () => {
  const state = base()
  state.variables[MC]['5.11']['page-latest-supported-hazelcast'] = '5.6'
  const expected = structuredClone(state)
  Object.assign(expected.variables[PLATFORM]['5.7'], {'full-version': '5.7.2', 'ee-version': '5.7.2'})
  expected.variables[MC]['5.11']['page-latest-supported-hazelcast'] = '5.7'
  assert.deepEqual(bump(patch('5.7.2', true), state), expected)
})

test('a patch of an older line changes only that line, not MC', () => {
  const state = base()
  state.variables[MC]['5.11']['page-latest-supported-hazelcast'] = '5.6'
  const expected = structuredClone(state)
  Object.assign(expected.variables[PLATFORM]['5.6'], {'full-version': '5.6.3', 'ee-version': '5.6.3'})
  assert.deepEqual(bump(patch('5.6.3', false), state), expected)
})

test('a major/minor release adds the release and moves main to the next snapshot', () => {
  const expected = base()
  const {current, ...releases} = expected.variables[PLATFORM]
  expected.variables[PLATFORM] = {
    current: {...current, 'full-version': '6.1.0-SNAPSHOT', 'os-version': '6.1.0-SNAPSHOT', 'ee-version': '6.1.0-SNAPSHOT',
      'minor-version': '6.1-SNAPSHOT', 'version': '6.1-SNAPSHOT'},
    '6.0': {...current, 'full-version': '6.0.0', 'os-version': '6.0.0', 'ee-version': '6.0.0',
      'minor-version': '6.0', 'version': '6.0'},
    ...releases,
  }
  expected.releases[PLATFORM] = ['6.0', '5.7', '5.6']
  Object.assign(expected.current[PLATFORM], {currentSeg: '6.1-snapshot', currentLabel: '6.1-SNAPSHOT'})
  expected.variables[MC].current['page-latest-supported-hazelcast'] = '6.1-snapshot'
  expected.variables[MC]['5.11']['page-latest-supported-hazelcast'] = '6.0'
  assert.deepEqual(bump(flags()), expected)
})

test('a major/minor release copies main and moves the latest redirects', () => {
  const {steps} = planBump(flags(), base())
  assert.deepEqual(steps.map((step) => step.step), ['addRelease', 'setCurrent', 'setVars', 'setLatestRedirects', 'dropPlaceholders', 'setVars', 'setVars'])
  assert.equal(steps.find((step) => step.step === 'addRelease').fromSeg, '6.0-snapshot')
  assert.deepEqual(steps.find((step) => step.step === 'setLatestRedirects'), {step: 'setLatestRedirects', component: PLATFORM, latest: '6.0', latestDev: '6.1-snapshot'})
})

test('a patch of a version that is not live changes nothing', () => {
  const {steps, notes} = planBump(patch('5.2.9', false), base())
  assert.deepEqual(steps, [])
  assert.match(notes.join('\n'), /5\.2 is not a live version/)
})

test('a value that already holds is not a step, so a release with nothing to change has no steps', () => {
  const state = base()
  Object.assign(state.variables[PLATFORM]['5.7'], {'full-version': '5.7.2', 'ee-version': '5.7.2'})
  assert.deepEqual(planBump(patch('5.7.2', true), state).steps, [])
})

test('rejects releases the tool cannot cut', () => {
  const state = base()
  const rejects = (overrides, pattern) => assert.throws(() => planBump(flags(overrides), state), pattern)
  rejects({RELEASE_VERSION: '6.0.0-BETA-1', IS_BETA_RELEASE: 'true', IS_REL_MAJOR_MINOR: 'false'}, /beta/)
  rejects({RELEASE_VERSION: '5.8.0', REL_MAJOR_MINOR: '5.8'}, /not the line main is on/)
  rejects({MASTER_VERSION: '6.0.0-SNAPSHOT', MASTER_MAJOR_MINOR: '6.0'}, /has not moved past 6\.0/)
  rejects({MASTER_VERSION: '6.2.0-SNAPSHOT'}, /does not match MASTER_MAJOR_MINOR/)
  rejects({IS_LATEST_STABLE_RELEASE: 'false'}, /not the latest stable/)
  rejects({IS_PATCH_RELEASE: 'true'}, /exactly one of/)
  rejects({REL_MAJOR_MINOR: '6.1'}, /does not match RELEASE_VERSION/)
  state.releases[PLATFORM].unshift('6.0')
  rejects({}, /already been released/)
})

test('rejects an MC version that src/variables.ts does not have', () => {
  assert.throws(() => planBump(patch('5.7.2', true), {...base(), variables: {...base().variables, [MC]: {current: {}}}}), /no management-center '5\.11' entry/)
  assert.throws(() => planBump(flags({MC_MAJOR_MINOR: '5.12'}), base()), /no management-center '5\.12' entry/)
})

test('rejects missing or malformed release info', () => {
  assert.throws(() => flagsFromEnv({}), /Missing release info/)
  assert.throws(() => flags({IS_PATCH_RELEASE: 'yes'}), /must be 'true' or 'false'/)
})

const release = (component, version, options = {}, state = base()) => {
  const {steps, notes} = planRelease(component, version, options, state)
  return {steps, notes, next: applyToState(state, steps)}
}

test('Platform by hand: the same result as the release pipeline', () => {
  assert.deepEqual(planRelease(PLATFORM, '6.0.0', {next: '6.1.0-SNAPSHOT'}, base()).steps, planBump(flags(), base()).steps)
  assert.deepEqual(planRelease(PLATFORM, '5.7.2', {}, base()).steps, planBump(patch('5.7.2', true), base()).steps)
  assert.deepEqual(planRelease(PLATFORM, '5.6.3', {}, base()).steps, planBump(patch('5.6.3', false), base()).steps)
})

test('an MC patch sets full-version and the swagger branch, and adds the release-notes alias', () => {
  const {steps, next} = release(MC, '5.11.2')
  const expected = base()
  Object.assign(expected.variables[MC]['5.11'], {'full-version': '5.11.2', 'mc-repo-swagger-branch': '5.11.2'})
  assert.deepEqual(next, expected)
  assert.deepEqual(steps.filter((step) => step.step === 'addAlias'), [{step: 'addAlias', component: MC, version: '5.11',
    from: '/management-center/5.11/release-notes/5-11-2', to: '/management-center/5.11/release-notes/release-notes'}])
})

test('an MC patch whose alias already exists does not add it again', () => {
  const state = base()
  state.redirects.push({from: '/management-center/5.11/release-notes/5-11-2', to: '/management-center/5.11/release-notes/release-notes'})
  assert.ok(!release(MC, '5.11.2', {}, state).steps.some((step) => step.step === 'addAlias'))
})

test('an MC major/minor adds the release, moves main to the next snapshot and points Platform main at it', () => {
  const {steps, next} = release(MC, '5.12.0', {next: '5.13.0-SNAPSHOT'})
  const expected = base()
  const {current, ...releases} = expected.variables[MC]
  expected.variables[MC] = {
    current: {...current, 'full-version': '5.13.0-SNAPSHOT'},
    '5.12': {...current, 'full-version': '5.12.0', 'mc-repo-swagger-branch': '5.12.0'},
    ...releases,
  }
  expected.releases[MC] = ['5.12', '5.11']
  Object.assign(expected.current[MC], {currentSeg: '5.13-snapshot', currentLabel: '5.13-SNAPSHOT'})
  expected.variables[PLATFORM].current['page-latest-supported-mc'] = '5.13-snapshot'
  assert.deepEqual(next, expected)
  assert.deepEqual(steps.find((step) => step.step === 'setLatestRedirects'), {step: 'setLatestRedirects', component: MC, latest: '5.12', latestDev: '5.13-snapshot'})
  assert.equal(steps.find((step) => step.step === 'addAlias').from, '/management-center/5.12/release-notes/5-12-0')
})

test('an MC release points the Platform version it supports at it', () => {
  const state = base()
  state.variables[PLATFORM]['5.7']['page-latest-supported-mc'] = '5.10'
  assert.equal(release(MC, '5.11.2', {}, state).next.variables[PLATFORM]['5.7']['page-latest-supported-mc'], '5.11')
})

test('a new Operator line adds the release with its chart and supported versions, and moves main to the upcoming snapshot', () => {
  const {steps, next} = release(OPERATOR, '5.20.0', {next: '5.21.0', hazelcast: '5.8.0', mc: '5.12.0'})
  const expected = base()
  const {current, ...releases} = expected.variables[OPERATOR]
  expected.variables[OPERATOR] = {
    current: {...current, 'operator-chart-version': '5.21.0-snapshot', 'page-latest-supported-hazelcast': '5.8.0', 'page-latest-supported-mc': '5.12.0'},
    '5.20': {'operator-chart-version': '5.20.0', 'page-latest-supported-hazelcast': '5.8.0', 'page-latest-supported-mc': '5.12.0'},
    ...releases,
  }
  expected.releases[OPERATOR] = ['5.20', '5.19', '5.18']
  assert.deepEqual(next, expected)
  assert.deepEqual(steps.find((step) => step.step === 'setLatestRedirects'), {step: 'setLatestRedirects', component: OPERATOR, latest: '5.20'})
})

test('an Operator patch updates its line and leaves the supported versions alone when not given', () => {
  const expected = base()
  expected.variables[OPERATOR]['5.19']['operator-chart-version'] = '5.19.1'
  assert.deepEqual(release(OPERATOR, '5.19.1', {next: '5.20.0'}).next, expected)
})

test('an Operator patch without --next keeps main on its upcoming snapshot', () => {
  const expected = base()
  expected.variables[OPERATOR]['5.19']['operator-chart-version'] = '5.19.1'
  assert.deepEqual(release(OPERATOR, '5.19.1').next, expected)
})

test('an Operator patch with a new --next moves main to that snapshot', () => {
  const expected = base()
  expected.variables[OPERATOR]['5.19']['operator-chart-version'] = '5.19.1'
  expected.variables[OPERATOR].current['operator-chart-version'] = '5.21.0-snapshot'
  assert.deepEqual(release(OPERATOR, '5.19.1', {next: '5.21.0'}).next, expected)
})

test('a CLC release freezes main as the outgoing version and renames main', () => {
  const {steps, next} = release(CLC, '5.5.2')
  const expected = base()
  const {current, ...releases} = expected.variables[CLC]
  expected.variables[CLC] = {current: {...current, 'full-version': '5.5.2'}, '5.5.1': {...current}, ...releases}
  expected.releases[CLC] = ['5.5.1', '5.5.0']
  expected.current[CLC] = {currentSeg: '5.5.2', defaultVersion: 'current'}
  assert.deepEqual(next, expected)
  assert.ok(steps.find((step) => step.step === 'setCurrent').keepOld, 'the outgoing segment stays, for the frozen copy')
  assert.deepEqual(steps.find((step) => step.step === 'dropPlaceholders'), {step: 'dropPlaceholders', component: CLC, segs: ['5.5.2']})
})

test('rejects product releases the tool cannot make', () => {
  const rejects = (component, version, options, pattern) => assert.throws(() => planRelease(component, version, options, base()), pattern)
  rejects(MC, '5.12.0', {}, /needs --next/)
  rejects(MC, '5.12.0', {next: '5.12.0-SNAPSHOT'}, /is not after/)
  rejects(MC, '5.13.0', {next: '5.14.0-SNAPSHOT'}, /not the line main is on/)
  rejects(OPERATOR, '5.20.0', {}, /needs --next/)
  rejects(OPERATOR, '5.20.3', {}, /needs --next/)
  rejects(OPERATOR, '5.19.1', {next: '5.19.0'}, /is not after/)
  rejects(OPERATOR, '5.20.0', {next: '5.20.0'}, /is not after/)
  rejects(CLC, '5.5.1', {}, /not after the current version/)
  rejects(CLC, '5.4.9', {}, /not after the current version/)
  rejects(PLATFORM, '6.0.0', {}, /needs --next/)
  rejects(MC, '5.12.0-BETA-1', {next: '5.13.0'}, /beta/)
  rejects('cloud', '1.0.0', {}, /Unknown component/)
})

test('an Operator release of a version that is not live changes nothing, including main', () => {
  const {steps, notes} = planRelease(OPERATOR, '5.17.5', {next: '5.20.0', hazelcast: '5.8.0'}, base())
  assert.deepEqual(steps, [])
  assert.match(notes.join('\n'), /5\.17 is not a live version/)
})

test('an Operator release of a version that is not live needs no --next', () => {
  assert.deepEqual(planRelease(OPERATOR, '5.17.5', {}, base()).steps, [])
})

test('a patch of an MC version that is not live changes nothing', () => {
  assert.deepEqual(planRelease(MC, '5.9.3', {}, base()).steps, [])
})
