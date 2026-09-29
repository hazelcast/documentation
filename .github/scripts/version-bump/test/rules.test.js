'use strict'

// Expected values first taken from the Antora updaters (hz-docs fe60348, management-center-docs dab0ba8).

const test = require('node:test')
const assert = require('node:assert/strict')
const {flagsFromEnv, planBump, applyToState, PLATFORM, MC} = require('../rules')

const base = () => ({
  current: {
    [PLATFORM]: {currentSeg: '6.0-snapshot', currentLabel: '6.0-SNAPSHOT', defaultVersion: 'latest-release'},
    [MC]: {currentSeg: '5.12-snapshot', currentLabel: '5.12-SNAPSHOT', defaultVersion: 'latest-release'},
  },
  releases: {[PLATFORM]: ['5.7', '5.6'], [MC]: ['5.11']},
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
      current: {'full-version': '5.12.0-SNAPSHOT', 'page-latest-supported-hazelcast': '6.0-snapshot'},
      '5.11': {'full-version': '5.11.1', 'page-latest-supported-hazelcast': '5.7'},
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

const bump = (releaseFlags, state = base()) => applyToState(state, planBump(releaseFlags, state).ops)

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
  const {ops} = planBump(flags(), base())
  assert.deepEqual(ops.map((op) => op.op), ['addRelease', 'setCurrent', 'setVars', 'setLatestRedirects', 'setVars', 'setVars'])
  assert.equal(ops.find((op) => op.op === 'addRelease').fromSeg, '6.0-snapshot')
  assert.deepEqual(ops.find((op) => op.op === 'setLatestRedirects'), {op: 'setLatestRedirects', component: PLATFORM, latest: '6.0', latestDev: '6.1-snapshot'})
})

test('a patch of a version that is not live changes nothing', () => {
  const {ops, notes} = planBump(patch('5.2.9', false), base())
  assert.deepEqual(ops, [])
  assert.match(notes.join('\n'), /5\.2 is not a live version/)
})

test('a value that already holds is not an op, so a no-op release has no ops', () => {
  const state = base()
  Object.assign(state.variables[PLATFORM]['5.7'], {'full-version': '5.7.2', 'ee-version': '5.7.2'})
  assert.deepEqual(planBump(patch('5.7.2', true), state).ops, [])
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
