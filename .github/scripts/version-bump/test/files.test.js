'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {flagsFromEnv, planBump} = require('../rules')
const {readState, applyOps, parseVariables, parseRedirects} = require('../files')

const siteRoot = path.resolve(__dirname, '..', '..', '..', '..')

const VARIABLES = {
  hazelcast: {
    current: {'ee-version': '6.0.0-SNAPSHOT', 'full-version': '6.0.0-SNAPSHOT', 'minor-version': '6.0-SNAPSHOT', 'os-version': '6.0.0-SNAPSHOT', 'version': '6.0-SNAPSHOT'},
    '5.7': {'ee-version': '5.7.1', 'full-version': '5.7.1', 'minor-version': '5.7', 'os-version': '5.7.0', 'version': '5.7'},
  },
  'management-center': {
    current: {'page-latest-supported-hazelcast': '6.0-snapshot'},
    '5.11': {'page-latest-supported-hazelcast': '5.7'},
  },
}

const PAGE = `import Note from '@site/hazelcast/_partials/_note.mdx';

<Note />

See [other](/hazelcast/6.0-snapshot/other), <a href="/hazelcast/6.0-snapshot/deep#anchor">deep</a>,
https://docs.hazelcast.com/hazelcast/6.0-snapshot/full and the [latest](/hazelcast/latest/page).
Not links to this version: /hazelcast/6.0-snapshot-extra, /x/hazelcast/6.0-snapshot/y, /hazelcast/5.7/old.
`

const FILES = {
  'src/currentVersions.json': JSON.stringify({
    hazelcast: {currentSeg: '6.0-snapshot', currentLabel: '6.0-SNAPSHOT', defaultVersion: 'latest-release'},
    'management-center': {currentSeg: '5.12-snapshot', currentLabel: '5.12-SNAPSHOT', defaultVersion: 'latest-release'},
  }, null, 2) + '\n',
  'hazelcast_versions.json': JSON.stringify(['5.7'], null, 2) + '\n',
  'management-center_versions.json': JSON.stringify(['5.11'], null, 2) + '\n',
  'src/variables.ts': '// header\nexport const variables = {};\n\nexport const versionedVariables: Record<string, Record<string, Record<string, string>>> = ' +
    JSON.stringify(VARIABLES, null, 2) + ';\n',
  'src/redirects.ts': '// header\nexport const redirects: {from: string; to: string}[] = [\n' +
    '  { from: "/cloud/a", to: "/cloud/b" },\n' +
    '  { from: "/hazelcast/5.7/old", to: "/hazelcast/5.7/new" },\n' +
    '  { from: "/hazelcast/6.0-snapshot", to: "/hazelcast/6.0-snapshot/index" },\n' +
    '  { from: "/hazelcast/6.0-snapshot/old", to: "/hazelcast/6.0-snapshot/new" },\n' +
    '];\n',
  'static/_redirects': '/hazelcast/latest/*       /hazelcast/5.7/:splat           307!\n' +
    '/hazelcast/latest-dev/*   /hazelcast/6.0-snapshot/:splat  307!\n' +
    '/imdg/latest-dev/*        /hazelcast/5.7-snapshot/:splat  307!\n',
  'hazelcast/_partials/_note.mdx': 'A note.\n',
  'hazelcast/page.mdx': PAGE,
  'hazelcast/images/pic.png': 'not really a png',
  'static/hazelcast/6.0-snapshot/pipelines/_attachments/data.txt': 'attachment\n',
  'static/hazelcast/5.7/pipelines/_attachments/data.txt': 'attachment\n',
}

function makeSite () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-bump-'))
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true})
    fs.writeFileSync(path.join(dir, file), text)
  }
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {stdio: 'pipe'})
  git('init', '-q')
  git('add', '-A')
  fs.writeFileSync(path.join(dir, 'hazelcast/untracked.mdx'), 'not in git\n')
  return dir
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const release = (overrides) => flagsFromEnv({
  RELEASE_VERSION: '6.0.0', REL_MAJOR_MINOR: '6.0', MASTER_VERSION: '6.1.0-SNAPSHOT', MASTER_MAJOR_MINOR: '6.1',
  MC_MAJOR_MINOR: '5.11', IS_PATCH_RELEASE: 'false', IS_REL_MAJOR_MINOR: 'true', IS_LATEST_STABLE_RELEASE: 'true',
  IS_BETA_RELEASE: 'false', ...overrides,
})

test('a major/minor release cuts the new version and moves main', () => {
  const dir = makeSite()
  applyOps(dir, planBump(release(), readState(dir)).ops)
  const copy = 'hazelcast_versioned_docs/version-6.0'

  assert.deepEqual(JSON.parse(read(dir, 'hazelcast_versions.json')), ['6.0', '5.7'])
  assert.ok(fs.existsSync(path.join(dir, copy, 'images/pic.png')))
  assert.ok(!fs.existsSync(path.join(dir, copy, 'untracked.mdx')), 'untracked files are not copied')

  const copied = read(dir, `${copy}/page.mdx`)
  assert.match(copied, /from '@site\/hazelcast_versioned_docs\/version-6\.0\/_partials\/_note\.mdx'/)
  assert.ok(fs.existsSync(path.join(dir, copy, '_partials/_note.mdx')), 'the rewritten import resolves')
  assert.match(copied, /\(\/hazelcast\/6\.0\/other\)/)
  assert.match(copied, /href="\/hazelcast\/6\.0\/deep#anchor"/)
  assert.match(copied, /https:\/\/docs\.hazelcast\.com\/hazelcast\/6\.0\/full/)
  assert.match(copied, /\/hazelcast\/latest\/page/)
  assert.match(copied, /\/hazelcast\/6\.0-snapshot-extra, \/x\/hazelcast\/6\.0-snapshot\/y, \/hazelcast\/5\.7\/old/)

  const main = read(dir, 'hazelcast/page.mdx')
  assert.match(main, /from '@site\/hazelcast\/_partials\/_note\.mdx'/, 'main keeps its own imports')
  assert.match(main, /\(\/hazelcast\/6\.1-snapshot\/other\)/)
  assert.match(main, /https:\/\/docs\.hazelcast\.com\/hazelcast\/6\.1-snapshot\/full/)
  assert.match(main, /\/hazelcast\/6\.0-snapshot-extra, \/x\/hazelcast\/6\.0-snapshot\/y/)

  assert.deepEqual(JSON.parse(read(dir, 'src/currentVersions.json')).hazelcast,
    {currentSeg: '6.1-snapshot', currentLabel: '6.1-SNAPSHOT', defaultVersion: 'latest-release'})

  const {variables} = parseVariables(read(dir, 'src/variables.ts'))
  assert.deepEqual(Object.keys(variables.hazelcast), ['current', '6.0', '5.7'])
  assert.equal(variables.hazelcast['6.0']['os-version'], '6.0.0')
  assert.equal(variables.hazelcast.current['full-version'], '6.1.0-SNAPSHOT')
  assert.equal(variables['management-center']['5.11']['page-latest-supported-hazelcast'], '6.0')
  assert.equal(variables['management-center'].current['page-latest-supported-hazelcast'], '6.1-snapshot')

  const {entries} = parseRedirects(read(dir, 'src/redirects.ts'))
  assert.deepEqual(entries, [
    {from: '/cloud/a', to: '/cloud/b'},
    {from: '/hazelcast/5.7/old', to: '/hazelcast/5.7/new'},
    {from: '/hazelcast/6.0', to: '/hazelcast/6.0/index'},
    {from: '/hazelcast/6.0/old', to: '/hazelcast/6.0/new'},
    {from: '/hazelcast/6.1-snapshot', to: '/hazelcast/6.1-snapshot/index'},
    {from: '/hazelcast/6.1-snapshot/old', to: '/hazelcast/6.1-snapshot/new'},
  ])

  const attachment = (seg) => path.join(dir, 'static/hazelcast', seg, 'pipelines/_attachments/data.txt')
  assert.ok(fs.existsSync(attachment('6.0')), 'static files are copied to the release')
  assert.ok(fs.existsSync(attachment('6.1-snapshot')), 'static files move with main')
  assert.ok(!fs.existsSync(path.join(dir, 'static/hazelcast/6.0-snapshot')), 'the old snapshot segment is gone')
  assert.ok(fs.existsSync(attachment('5.7')))

  assert.equal(read(dir, 'static/_redirects'),
    '/hazelcast/latest/*       /hazelcast/6.0/:splat           307!\n' +
    '/hazelcast/latest-dev/*   /hazelcast/6.1-snapshot/:splat  307!\n' +
    '/imdg/latest-dev/*        /hazelcast/5.7-snapshot/:splat  307!\n')
})

test('a patch changes only the variables', () => {
  const dir = makeSite()
  const patch = release({RELEASE_VERSION: '5.7.2', REL_MAJOR_MINOR: '5.7', MASTER_VERSION: '6.0.0-SNAPSHOT',
    MASTER_MAJOR_MINOR: '6.0', IS_PATCH_RELEASE: 'true', IS_REL_MAJOR_MINOR: 'false'})
  applyOps(dir, planBump(patch, readState(dir)).ops)
  for (const [file, text] of Object.entries(FILES)) {
    if (file !== 'src/variables.ts') assert.equal(read(dir, file), text, `${file} unchanged`)
  }
  assert.equal(parseVariables(read(dir, 'src/variables.ts')).variables.hazelcast['5.7']['full-version'], '5.7.2')
})

test('refuses a cut when a copy of that version already exists', () => {
  const dir = makeSite()
  fs.mkdirSync(path.join(dir, 'hazelcast_versioned_docs/version-6.0'), {recursive: true})
  assert.throws(() => applyOps(dir, planBump(release(), readState(dir)).ops), /already exists/)
})

test('refuses files it would reformat', () => {
  assert.throws(() => parseVariables(FILES['src/variables.ts'].replace('"current": {', '"current": { // note')), /JSON|format/)
  assert.throws(() => parseRedirects(FILES['src/redirects.ts'].replace('{ from: "/cloud/a"', '{from: "/cloud/a"')), /unexpected line/)
  assert.throws(() => parseRedirects(FILES['src/redirects.ts'].replace(
    '  { from: "/cloud/a", to: "/cloud/b" },\n  { from: "/hazelcast/5.7/old", to: "/hazelcast/5.7/new" },\n',
    '  { from: "/hazelcast/5.7/old", to: "/hazelcast/5.7/new" },\n  { from: "/cloud/a", to: "/cloud/b" },\n')), /format/)
})

test("the site's own files are in the format the bump writes", () => {
  const state = readState(siteRoot)
  assert.ok(state.variables.hazelcast.current)
  parseRedirects(read(siteRoot, 'src/redirects.ts'))
})
