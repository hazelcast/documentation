'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {backport} = require('../apply')

const STATE = {
  'src/currentVersions.json': JSON.stringify({
    hazelcast: {currentSeg: '6.0-snapshot', currentLabel: '6.0-SNAPSHOT', defaultVersion: 'latest-release'},
    operator: {currentSeg: 'latest-snapshot', defaultVersion: 'latest-release'},
  }),
  'hazelcast_versions.json': JSON.stringify(['5.7', '5.6']),
  'operator_versions.json': JSON.stringify(['5.20']),
}

const page = (dir, seg, body) => `import Note from '@site/${dir}/_partials/_note.mdx';

<Note />

${body}

See [maps](/hazelcast/${seg}/maps) and [the operator](/operator/latest/intro).
`

function repo (files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backport-test-'))
  write(dir, {...STATE, ...files})
  run(dir, 'init', '-q', '-b', 'main')
  commit(dir, 'initial')
  return dir
}

function write (dir, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true})
    fs.writeFileSync(path.join(dir, file), content)
  }
}

const run = (dir, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {cwd: dir}).toString()
function commit (dir, message) {
  run(dir, 'add', '-A')
  run(dir, 'commit', '-q', '-m', message)
}
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const exists = (dir, file) => fs.existsSync(path.join(dir, file))
const outcomes = (result) => Object.fromEntries(result.results.flatMap((job) => job.files.map(({file, outcome}) => [file, outcome])))

const V57 = 'hazelcast_versioned_docs/version-5.7'
const V56 = 'hazelcast_versioned_docs/version-5.6'

test('a committed change to main lands in each named release, with that release\'s imports and links', () => {
  const dir = repo({
    'hazelcast/maps.mdx': page('hazelcast', '6.0-snapshot', 'Maps are fast.'),
    [`${V57}/maps.mdx`]: page(V57, '5.7', 'Maps are fast.'),
    [`${V56}/maps.mdx`]: page(V56, '5.6', 'Maps are fast.'),
  })
  write(dir, {'hazelcast/maps.mdx': page('hazelcast', '6.0-snapshot', 'Maps are fast and [partitioned](/hazelcast/6.0-snapshot/partitions).')})
  commit(dir, 'change')

  const result = backport(dir, {targets: ['5.7', '5.6'], commit: 'HEAD'})

  assert.deepEqual(outcomes(result), {[`${V57}/maps.mdx`]: 'applied', [`${V56}/maps.mdx`]: 'applied'})
  assert.equal(read(dir, `${V57}/maps.mdx`), page(V57, '5.7', 'Maps are fast and [partitioned](/hazelcast/5.7/partitions).'))
  assert.equal(read(dir, `${V56}/maps.mdx`), page(V56, '5.6', 'Maps are fast and [partitioned](/hazelcast/5.6/partitions).'))
})

test('a release that differs elsewhere in the page keeps its own text', () => {
  const dir = repo({
    'hazelcast/maps.mdx': 'Intro.\n\nFirst.\n\nMiddle.\n\nLast.\n',
    [`${V57}/maps.mdx`]: 'Intro for 5.7.\n\nFirst.\n\nMiddle.\n\nLast.\n',
  })
  write(dir, {'hazelcast/maps.mdx': 'Intro.\n\nFirst.\n\nMiddle.\n\nLast, fixed.\n'})

  const result = backport(dir, {targets: ['5.7']})

  assert.deepEqual(outcomes(result), {[`${V57}/maps.mdx`]: 'applied'})
  assert.equal(read(dir, `${V57}/maps.mdx`), 'Intro for 5.7.\n\nFirst.\n\nMiddle.\n\nLast, fixed.\n')
})

test('a clash with the release\'s own text leaves conflict markers labelled with both versions', () => {
  const dir = repo({
    'hazelcast/maps.mdx': 'Maps are fast.\n',
    [`${V57}/maps.mdx`]: 'Maps in 5.7 are fast.\n',
  })
  write(dir, {'hazelcast/maps.mdx': 'Maps are very fast.\n'})

  const result = backport(dir, {targets: ['5.7']})

  assert.deepEqual(outcomes(result), {[`${V57}/maps.mdx`]: 'conflict'})
  assert.equal(read(dir, `${V57}/maps.mdx`), '<<<<<<< 5.7\nMaps in 5.7 are fast.\n=======\nMaps are very fast.\n>>>>>>> 6.0-snapshot\n')
})

test('a page a release does not have is reported, not created', () => {
  const dir = repo({'hazelcast/new.mdx': 'Old.\n'})
  write(dir, {'hazelcast/new.mdx': 'New.\n'})

  const result = backport(dir, {targets: ['5.7']})

  assert.deepEqual(outcomes(result), {[`${V57}/new.mdx`]: 'missing'})
  assert.equal(exists(dir, `${V57}/new.mdx`), false)
})

test('an added page is created in a release that lacks it and refused where a different one exists', () => {
  const dir = repo({[`${V56}/added.mdx`]: 'Something else.\n'})
  write(dir, {'hazelcast/added.mdx': page('hazelcast', '6.0-snapshot', 'Added.')})

  const result = backport(dir, {targets: ['5.7', '5.6']})

  assert.deepEqual(outcomes(result), {[`${V57}/added.mdx`]: 'applied', [`${V56}/added.mdx`]: 'not applied'})
  assert.equal(read(dir, `${V57}/added.mdx`), page(V57, '5.7', 'Added.'))
  assert.equal(read(dir, `${V56}/added.mdx`), 'Something else.\n')
})

test('a deletion removes the release\'s copy only when it matches the deleted page', () => {
  const dir = repo({
    'hazelcast/gone.mdx': page('hazelcast', '6.0-snapshot', 'Gone.'),
    [`${V57}/gone.mdx`]: page(V57, '5.7', 'Gone.'),
    [`${V56}/gone.mdx`]: page(V56, '5.6', 'Gone, but edited in 5.6.'),
  })
  fs.rmSync(path.join(dir, 'hazelcast/gone.mdx'))

  const result = backport(dir, {targets: ['5.7', '5.6']})

  assert.deepEqual(outcomes(result), {[`${V57}/gone.mdx`]: 'applied', [`${V56}/gone.mdx`]: 'not applied'})
  assert.equal(exists(dir, `${V57}/gone.mdx`), false)
  assert.equal(exists(dir, `${V56}/gone.mdx`), true)
})

test('a rename moves the release\'s page and carries the edit with it', () => {
  const dir = repo({
    'hazelcast/old.mdx': 'Intro.\n\nBody.\n\nMore.\n\nEnd.\n',
    [`${V57}/old.mdx`]: 'Intro for 5.7.\n\nBody.\n\nMore.\n\nEnd.\n',
  })
  run(dir, 'mv', 'hazelcast/old.mdx', 'hazelcast/new.mdx')
  write(dir, {'hazelcast/new.mdx': 'Intro.\n\nBody.\n\nMore.\n\nEnd, edited.\n'})
  commit(dir, 'rename')

  const result = backport(dir, {targets: ['5.7'], commit: 'HEAD'})

  assert.deepEqual(outcomes(result), {[`${V57}/new.mdx`]: 'applied'})
  assert.equal(exists(dir, `${V57}/old.mdx`), false)
  assert.equal(read(dir, `${V57}/new.mdx`), 'Intro for 5.7.\n\nBody.\n\nMore.\n\nEnd, edited.\n')
})

test('an uncommitted rename made without git mv is still a rename', () => {
  const dir = repo({
    'hazelcast/old.mdx': 'Intro.\n\nBody.\n\nMore.\n\nEnd.\n',
    [`${V57}/old.mdx`]: 'Intro for 5.7.\n\nBody.\n\nMore.\n\nEnd.\n',
  })
  fs.renameSync(path.join(dir, 'hazelcast/old.mdx'), path.join(dir, 'hazelcast/new.mdx'))
  write(dir, {'hazelcast/new.mdx': 'Intro.\n\nBody.\n\nMore.\n\nEnd, edited.\n'})

  const result = backport(dir, {targets: ['5.7']})

  assert.deepEqual(outcomes(result), {[`${V57}/new.mdx`]: 'applied'})
  assert.equal(exists(dir, `${V57}/old.mdx`), false)
  assert.equal(read(dir, `${V57}/new.mdx`), 'Intro for 5.7.\n\nBody.\n\nMore.\n\nEnd, edited.\n')
  assert.equal(run(dir, 'status', '--porcelain'), ` D hazelcast/old.mdx\n D ${V57}/old.mdx\n?? hazelcast/new.mdx\n?? ${V57}/new.mdx\n`)
})

test('a static attachment follows the version segment', () => {
  const dir = repo({
    'static/hazelcast/6.0-snapshot/config.yaml': 'a: 1\n',
    'static/hazelcast/5.7/config.yaml': 'a: 1\n',
  })
  write(dir, {'static/hazelcast/6.0-snapshot/config.yaml': 'a: 2\n'})

  const result = backport(dir, {targets: ['5.7']})

  assert.deepEqual(outcomes(result), {'static/hazelcast/5.7/config.yaml': 'applied'})
  assert.equal(read(dir, 'static/hazelcast/5.7/config.yaml'), 'a: 2\n')
})

test('a changed image replaces the release\'s copy only when that copy was the old image', () => {
  const oldImage = Buffer.from([0x89, 0x50, 0, 1])
  const newImage = Buffer.from([0x89, 0x50, 0, 2])
  const dir = repo({
    'hazelcast/images/a.png': oldImage,
    [`${V57}/images/a.png`]: oldImage,
    [`${V56}/images/a.png`]: Buffer.from([0x89, 0x50, 0, 3]),
  })
  write(dir, {'hazelcast/images/a.png': newImage})

  const result = backport(dir, {targets: ['5.7', '5.6']})

  assert.deepEqual(outcomes(result), {[`${V57}/images/a.png`]: 'applied', [`${V56}/images/a.png`]: 'not applied'})
  assert.deepEqual(fs.readFileSync(path.join(dir, `${V57}/images/a.png`)), newImage)
})

test('a fix made in a release can go to main and to another release', () => {
  const dir = repo({
    'hazelcast/maps.mdx': page('hazelcast', '6.0-snapshot', 'Typo hre.'),
    [`${V57}/maps.mdx`]: page(V57, '5.7', 'Typo hre.'),
    [`${V56}/maps.mdx`]: page(V56, '5.6', 'Typo hre.'),
  })
  write(dir, {[`${V57}/maps.mdx`]: page(V57, '5.7', 'Typo here.')})

  const result = backport(dir, {targets: ['current', '5.6']})

  assert.deepEqual(outcomes(result), {'hazelcast/maps.mdx': 'applied', [`${V56}/maps.mdx`]: 'applied'})
  assert.equal(read(dir, 'hazelcast/maps.mdx'), page('hazelcast', '6.0-snapshot', 'Typo here.'))
  assert.equal(read(dir, `${V56}/maps.mdx`), page(V56, '5.6', 'Typo here.'))
})

test('changes in two versions of a product need --from, which then picks one', () => {
  const dir = repo({
    'hazelcast/a.mdx': 'A.\n',
    [`${V57}/a.mdx`]: 'A.\n',
    [`${V57}/b.mdx`]: 'B.\n',
    [`${V56}/a.mdx`]: 'A.\n',
  })
  write(dir, {'hazelcast/a.mdx': 'A, fixed.\n', [`${V57}/b.mdx`]: 'B, fixed.\n'})

  assert.throws(() => backport(dir, {targets: ['5.6']}), /more than one version \(6\.0-snapshot, 5\.7\).*--from/)

  const result = backport(dir, {targets: ['5.6'], from: 'current'})
  assert.deepEqual(outcomes(result), {[`${V56}/a.mdx`]: 'applied'})
  assert.equal(read(dir, `${V56}/a.mdx`), 'A, fixed.\n')
})

test('running it again is harmless', () => {
  const dir = repo({'hazelcast/a.mdx': 'A.\n', [`${V57}/a.mdx`]: 'A.\n'})
  write(dir, {'hazelcast/a.mdx': 'A, fixed.\n'})
  backport(dir, {targets: ['5.7']})

  const result = backport(dir, {targets: ['5.7'], from: 'current'})

  assert.deepEqual(outcomes(result), {[`${V57}/a.mdx`]: 'unchanged'})
  assert.equal(read(dir, `${V57}/a.mdx`), 'A, fixed.\n')
})

test('each product goes to the versions it has, and files outside version folders are left alone', () => {
  const dir = repo({
    'hazelcast/a.mdx': 'A.\n',
    [`${V57}/a.mdx`]: 'A.\n',
    'operator/o.mdx': 'O.\n',
    'operator_versioned_docs/version-5.20/o.mdx': 'O.\n',
    'src/redirects.ts': 'x\n',
  })
  write(dir, {'hazelcast/a.mdx': 'A, fixed.\n', 'operator/o.mdx': 'O, fixed.\n', 'src/redirects.ts': 'y\n'})

  const result = backport(dir, {targets: ['5.7', '5.20']})

  assert.deepEqual(outcomes(result), {[`${V57}/a.mdx`]: 'applied', 'operator_versioned_docs/version-5.20/o.mdx': 'applied'})
  assert.deepEqual(result.ignored, ['src/redirects.ts'])
  assert.deepEqual(result.notes, ["hazelcast: has no version '5.20'", "operator: has no version '5.7'"])
})

test('a version no changed product has is an error, and nothing is written', () => {
  const dir = repo({'hazelcast/a.mdx': 'A.\n', [`${V57}/a.mdx`]: 'A.\n'})
  write(dir, {'hazelcast/a.mdx': 'A, fixed.\n'})

  assert.throws(() => backport(dir, {targets: ['5.7', '5.8']}), /No product you changed has a version '5\.8'/)
  assert.equal(read(dir, `${V57}/a.mdx`), 'A.\n')
})

test('a dry run reports what would happen without writing', () => {
  const dir = repo({'hazelcast/a.mdx': 'A.\n', [`${V57}/a.mdx`]: 'A.\n'})
  write(dir, {'hazelcast/a.mdx': 'A, fixed.\n', 'hazelcast/new.mdx': 'New.\n'})

  const result = backport(dir, {targets: ['5.7'], dryRun: true})

  assert.deepEqual(outcomes(result), {[`${V57}/a.mdx`]: 'applied', [`${V57}/new.mdx`]: 'applied'})
  assert.equal(read(dir, `${V57}/a.mdx`), 'A.\n')
  assert.equal(exists(dir, `${V57}/new.mdx`), false)
})

test('with nothing changed there is nothing to do', () => {
  const dir = repo({'hazelcast/a.mdx': 'A.\n'})
  assert.throws(() => backport(dir, {targets: ['5.7']}), /no uncommitted changes/)
})
