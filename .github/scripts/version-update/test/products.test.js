'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {planRelease} = require('../rules')
const {readState, applySteps, parseVariables, parseRedirects} = require('../files')

const VARIABLES = {
  hazelcast: {
    current: {'page-latest-supported-mc': '5.12-snapshot'},
    '5.7': {'page-latest-supported-mc': '5.11'},
  },
  'management-center': {
    current: {'full-version': '5.12.0-SNAPSHOT', 'mc-repo-swagger-branch': 'master', 'page-latest-supported-hazelcast': '6.0-snapshot'},
    '5.11': {'full-version': '5.11.1', 'mc-repo-swagger-branch': '5.11.1', 'page-latest-supported-hazelcast': '5.7'},
  },
  operator: {
    current: {'operator-chart-version': '5.20.0-snapshot', 'page-latest-supported-hazelcast': '5.7.1'},
    '5.19': {'operator-chart-version': '5.19.0', 'page-latest-supported-hazelcast': '5.7.1'},
  },
  clc: {
    current: {'full-version': '5.5.1'},
    '5.5.0': {'full-version': '5.5.0'},
  },
}

const RELEASE_NOTES = '---\ntitle: "Release Notes"\nslug: /release-notes/release-notes\n---\n\n## 5.11.1\n'

const FILES = {
  'src/currentVersions.json': JSON.stringify({
    hazelcast: {currentSeg: '6.0-snapshot', currentLabel: '6.0-SNAPSHOT', defaultVersion: 'latest-release'},
    operator: {currentSeg: 'latest-snapshot', defaultVersion: 'latest-release'},
    clc: {currentSeg: '5.5.1', defaultVersion: 'current'},
    'management-center': {currentSeg: '5.12-snapshot', currentLabel: '5.12-SNAPSHOT', defaultVersion: 'latest-release'},
  }, null, 2) + '\n',
  'hazelcast_versions.json': JSON.stringify(['5.7'], null, 2) + '\n',
  'management-center_versions.json': JSON.stringify(['5.11'], null, 2) + '\n',
  'operator_versions.json': JSON.stringify(['5.19'], null, 2) + '\n',
  'clc_versions.json': JSON.stringify(['5.5.0'], null, 2) + '\n',
  'src/variables.ts': 'export const versionedVariables: Record<string, Record<string, Record<string, string>>> = ' +
    JSON.stringify(VARIABLES, null, 2) + ';\n',
  'src/redirects.ts': 'export const redirects: {from: string; to: string}[] = [\n' +
    '  { from: "/clc/5.5.1", to: "/clc/5.5.1/overview" },\n' +
    '  { from: "/management-center/5.11/release-notes/5-11-0", to: "/management-center/5.11/release-notes/release-notes" },\n' +
    '  { from: "/operator/latest-snapshot/old", to: "/operator/latest-snapshot/new" },\n' +
    '];\n',
  'static/_redirects': [
    '/management-center/latest/*      /management-center/5.11/:splat        307!',
    '/management-center/latest-dev/*  /management-center/5.12-snapshot/:splat  307!',
    '/operator/latest/*               /operator/5.19/:splat                 307!',
    '/operator/latest-dev/*           /operator/latest-snapshot/:splat      307!',
    '/clc/latest-dev/*                /clc/latest/:splat                    307!',
    '/clc/latest/*                    /clc/5.5.1/:splat                     307!',
    '/clc/5.5.2/*  /clc/5.5.0/:splat  307!',
    '/clc/6.0.0/*  /clc/5.5.0/:splat  307!',
    '',
  ].join('\n'),
  'clc/overview.mdx': 'See [the commands](/clc/5.5.1/commands).\n',
  'management-center/install-and-upgrade/release-notes.mdx': RELEASE_NOTES.replace('## 5.11.1', '## 5.12.0'),
  'management-center_versioned_docs/version-5.11/install-and-upgrade/release-notes.mdx': RELEASE_NOTES,
  'management-center/page.mdx': 'Link to [this version](/management-center/5.12-snapshot/page).\n',
  'operator/page.mdx': 'Link to [this version](/operator/latest-snapshot/page).\n',
}

function makeSite () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-update-products-'))
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true})
    fs.writeFileSync(path.join(dir, file), text)
  }
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'add', '-A'])
  return dir
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const bump = (dir, component, version, options = {}) => applySteps(dir, planRelease(component, version, options, readState(dir)).steps)

test('a CLC release freezes main under its own version and moves main to the new one', () => {
  const dir = makeSite()
  bump(dir, 'clc', '5.5.2')

  assert.deepEqual(JSON.parse(read(dir, 'clc_versions.json')), ['5.5.1', '5.5.0'])
  assert.equal(read(dir, 'clc_versioned_docs/version-5.5.1/overview.mdx'), 'See [the commands](/clc/5.5.1/commands).\n', 'the frozen copy keeps its links')
  assert.equal(read(dir, 'clc/overview.mdx'), 'See [the commands](/clc/5.5.2/commands).\n')
  assert.deepEqual(JSON.parse(read(dir, 'src/currentVersions.json')).clc, {currentSeg: '5.5.2', defaultVersion: 'current'})
  assert.deepEqual(parseVariables(read(dir, 'src/variables.ts')).variables.clc,
    {current: {'full-version': '5.5.2'}, '5.5.1': {'full-version': '5.5.1'}, '5.5.0': {'full-version': '5.5.0'}})
  const redirects = parseRedirects(read(dir, 'src/redirects.ts')).entries.filter(({from}) => from.startsWith('/clc/'))
  assert.deepEqual(redirects, [{from: '/clc/5.5.1', to: '/clc/5.5.1/overview'}, {from: '/clc/5.5.2', to: '/clc/5.5.2/overview'}])
  const netlify = read(dir, 'static/_redirects')
  assert.match(netlify, /^\/clc\/latest\/\* +\/clc\/5\.5\.2\/:splat/m)
  assert.doesNotMatch(netlify, /^\/clc\/5\.5\.2\/\*/m, 'the placeholder for 5.5.2 is gone')
  assert.match(netlify, /^\/clc\/6\.0\.0\/\*/m, 'other placeholders stay')
})

test('an MC patch adds the release-notes alias the downloads page links to', () => {
  const dir = makeSite()
  bump(dir, 'management-center', '5.11.2')
  assert.ok(parseRedirects(read(dir, 'src/redirects.ts')).entries.some(({from, to}) =>
    from === '/management-center/5.11/release-notes/5-11-2' && to === '/management-center/5.11/release-notes/release-notes'))
  assert.equal(parseVariables(read(dir, 'src/variables.ts')).variables['management-center']['5.11']['mc-repo-swagger-branch'], '5.11.2')
})

test('an MC alias to a page that does not exist stops the bump', () => {
  const dir = makeSite()
  fs.rmSync(path.join(dir, 'management-center_versioned_docs/version-5.11/install-and-upgrade/release-notes.mdx'))
  execFileSync('git', ['-C', dir, 'add', '-A'])
  assert.throws(() => bump(dir, 'management-center', '5.11.2'), /no page at \/management-center\/5\.11\/release-notes\/release-notes/)
})

test('an MC major/minor cuts the release, moves main and adds the .0 alias', () => {
  const dir = makeSite()
  bump(dir, 'management-center', '5.12.0', {next: '5.13.0-SNAPSHOT'})
  assert.equal(read(dir, 'management-center_versioned_docs/version-5.12/page.mdx'), 'Link to [this version](/management-center/5.12/page).\n')
  assert.equal(read(dir, 'management-center/page.mdx'), 'Link to [this version](/management-center/5.13-snapshot/page).\n')
  assert.ok(parseRedirects(read(dir, 'src/redirects.ts')).entries.some(({from}) => from === '/management-center/5.12/release-notes/5-12-0'))
  assert.match(read(dir, 'static/_redirects'), /^\/management-center\/latest\/\* +\/management-center\/5\.12\/:splat/m)
  assert.match(read(dir, 'static/_redirects'), /^\/management-center\/latest-dev\/\* +\/management-center\/5\.13-snapshot\/:splat/m)
  assert.equal(parseVariables(read(dir, 'src/variables.ts')).variables.hazelcast.current['page-latest-supported-mc'], '5.13-snapshot')
})

test('a new Operator line copies main without renaming it', () => {
  const dir = makeSite()
  bump(dir, 'operator', '5.20.0', {next: '5.21.0'})
  assert.equal(read(dir, 'operator_versioned_docs/version-5.20/page.mdx'), 'Link to [this version](/operator/5.20/page).\n')
  assert.equal(read(dir, 'operator/page.mdx'), FILES['operator/page.mdx'], 'main stays latest-snapshot')
  assert.ok(parseRedirects(read(dir, 'src/redirects.ts')).entries.some(({from}) => from === '/operator/5.20/old'))
  assert.match(read(dir, 'static/_redirects'), /^\/operator\/latest\/\* +\/operator\/5\.20\/:splat/m)
  assert.match(read(dir, 'static/_redirects'), /^\/operator\/latest-dev\/\* +\/operator\/latest-snapshot\/:splat/m)
  assert.equal(parseVariables(read(dir, 'src/variables.ts')).variables.operator.current['operator-chart-version'], '5.21.0-snapshot')
})

test('a bump that fails partway leaves the checkout as it was', () => {
  const dir = makeSite()
  fs.rmSync(path.join(dir, 'management-center/install-and-upgrade/release-notes.mdx'))
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'])
  assert.throws(() => bump(dir, 'management-center', '5.12.0', {next: '5.13.0-SNAPSHOT'}), /no page at/)
  assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'}), '')
})
