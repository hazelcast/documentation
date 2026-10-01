'use strict'

// Spec: every example file a `<component>/examples.json` references is staged byte-for-byte from its pinned commit,
// verified against its recorded sha256, and anything that cannot be staged exactly fails the build.
// GitHub is replaced by a mocked fetch.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tutorialExamples = require('..')

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const SHA = 'a'.repeat(40)

const entry = (id, content, extra = {}) => ({id, repo: 'hazelcast-guides/demo', sha: SHA, path: `src/${path.basename(id)}`, sha256: sha256(content), ...extra})

const tmpDirs = []
test.after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})))

function site (manifests, staged = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-examples-'))
  tmpDirs.push(dir)
  for (const [component, files] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(dir, component), {recursive: true})
    fs.writeFileSync(path.join(dir, component, 'examples.json'), JSON.stringify({files}))
  }
  for (const [rel, content] of Object.entries(staged)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
    fs.writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

// raw.githubusercontent.com stand-in serving `files` keyed by `<repo>/<sha>/<path>`.
function github (t, files) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    const key = new URL(url).pathname.slice(1)
    calls.push(key)
    return key in files ? new Response(Buffer.from(files[key], 'utf8')) : new Response('404', {status: 404})
  })
  return calls
}

const load = (dir) => tutorialExamples({siteDir: dir}).loadContent()
const staged = (dir, id) => fs.readFileSync(path.join(dir, '.tutorial-examples', id), 'utf8')

test.beforeEach((t) => t.mock.method(console, 'log', () => {}))

test('each referenced file is fetched from its pinned commit and staged under its id', async (t) => {
  const java = 'class A {}\n'
  const dir = site({tutorials: [entry('demo/A.java', java)]})
  const calls = github(t, {[`hazelcast-guides/demo/${SHA}/src/A.java`]: java})
  await load(dir)
  assert.deepEqual(calls, [`hazelcast-guides/demo/${SHA}/src/A.java`])
  assert.equal(staged(dir, 'demo/A.java'), java)
})

test('a file with a UTF-8 BOM is staged with its BOM, so it matches its recorded hash', async (t) => {
  const bom = '﻿using System;\n'
  const dir = site({tutorials: [entry('demo/A.cs', bom)]})
  github(t, {[`hazelcast-guides/demo/${SHA}/src/A.cs`]: bom})
  await load(dir)
  assert.equal(staged(dir, 'demo/A.cs'), bom)
})

test('content that does not match its recorded hash fails the build and is not staged', async (t) => {
  const dir = site({tutorials: [entry('demo/A.java', 'class A {}\n')]})
  github(t, {[`hazelcast-guides/demo/${SHA}/src/A.java`]: 'class Tampered {}\n'})
  await assert.rejects(load(dir), /content hash mismatch for hazelcast-guides\/demo\/src\/A\.java/)
  assert.ok(!fs.existsSync(path.join(dir, '.tutorial-examples', 'demo/A.java')))
})

test('every file that cannot be fetched is named in one failure', async (t) => {
  const dir = site({tutorials: [entry('demo/A.java', 'a'), entry('demo/B.java', 'b')]})
  github(t, {})
  await assert.rejects(load(dir), (err) => /2 example file\(s\)/.test(err.message) && /demo\/A\.java/.test(err.message) && /demo\/B\.java/.test(err.message))
})

test('a file already staged from the same commit is not fetched again; a new pin refetches it', async (t) => {
  const v1 = 'v1\n'
  const v2 = 'v2\n'
  const dir = site({tutorials: [entry('demo/A.java', v1)]})
  const calls = github(t, {
    [`hazelcast-guides/demo/${SHA}/src/A.java`]: v1,
    [`hazelcast-guides/demo/${'b'.repeat(40)}/src/A.java`]: v2,
  })
  await load(dir)
  await load(dir)
  assert.equal(calls.length, 1)

  fs.writeFileSync(path.join(dir, 'tutorials', 'examples.json'), JSON.stringify({files: [entry('demo/A.java', v2, {sha: 'b'.repeat(40)})]}))
  await load(dir)
  assert.equal(calls.length, 2)
  assert.equal(staged(dir, 'demo/A.java'), v2)
})

test('manifests in any top-level component are merged, and a file two of them share is fetched once', async (t) => {
  const shared = 'shared\n'
  const dir = site({tutorials: [entry('demo/S.java', shared)], hazelcast: [entry('demo/S.java', shared)]})
  const calls = github(t, {[`hazelcast-guides/demo/${SHA}/src/S.java`]: shared})
  await load(dir)
  assert.equal(calls.length, 1)
})

test('two manifests disagreeing on one file\'s content fail rather than overwrite each other', async (t) => {
  const dir = site({tutorials: [entry('demo/S.java', 'one')], hazelcast: [entry('demo/S.java', 'two')]})
  github(t, {})
  await assert.rejects(load(dir), /demo\/S\.java is declared by two manifests with different content/)
})

test('staged files no manifest references any more are removed', async (t) => {
  const dir = site({tutorials: [entry('demo/A.java', 'a')]}, {'.tutorial-examples/old/Gone.java': 'x'})
  github(t, {[`hazelcast-guides/demo/${SHA}/src/A.java`]: 'a'})
  await load(dir)
  assert.ok(!fs.existsSync(path.join(dir, '.tutorial-examples', 'old')))
})

test('with no manifests nothing is fetched and no staging dir is created', async (t) => {
  const dir = site({})
  const calls = github(t, {})
  await load(dir)
  assert.equal(calls.length, 0)
  assert.ok(!fs.existsSync(path.join(dir, '.tutorial-examples')))
})
