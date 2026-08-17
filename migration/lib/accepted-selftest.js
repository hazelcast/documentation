'use strict'

// Unit self-test for lib/accepted.js -- the accept-list mechanism shared by the
// fidelity and refs gates. What matters here is not that matching works but that
// the mechanism cannot be used to make a gate lie: keys are occurrence-exact,
// nothing clears by pattern, a reason is mandatory, and an entry that stops
// matching fails instead of quietly rotting. Run:
//   node lib/accepted-selftest.js

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DISPOSITIONS, loadAccepted, validate, applyAccepted } = require('./accepted')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// The gates' finding shape, reduced to what the key is built from.
const keyOf = (f) => `refs:baked:${f.component}@ ${f.url} {${f.name}} ${f.expected}->${f.actual}`
const finding = (over = {}) => ({ component: 'cloud', url: '/cloud/x', name: 'a', expected: 12, actual: 11, ...over })

// --- occurrence-exact: the property that makes acceptance safe ---------------
// Accepting "12 expected, 11 found" must NOT accept a second bake on the same
// page. If it did, one accepted finding would blind the gate to that page.
{
  const accept = { [keyOf(finding())]: { disposition: 'wont-fix', note: 'known' } }

  const same = applyAccepted([finding()], accept, keyOf)
  assert.strictEqual(same.accepted.length, 1, 'the exact finding is accepted')
  assert.strictEqual(same.blocking.length, 0, 'and does not block')

  const worse = applyAccepted([finding({ actual: 10 })], accept, keyOf)
  assert.strictEqual(worse.blocking.length, 1, 'a SECOND baked occurrence on the same page still blocks')
  assert.strictEqual(worse.accepted.length, 0, 'and is not treated as accepted')

  const other = applyAccepted([finding({ name: 'b' })], accept, keyOf)
  assert.strictEqual(other.blocking.length, 1, 'a different attribute on the same page still blocks')

  const elsewhere = applyAccepted([finding({ url: '/cloud/y' })], accept, keyOf)
  assert.strictEqual(elsewhere.blocking.length, 1, 'the same finding on another page still blocks')
  ok('applyAccepted: occurrence-exact — pins page, attribute AND counts; nothing else clears')
}

// --- deny by default --------------------------------------------------------
{
  const empty = applyAccepted([finding(), finding({ url: '/cloud/y' })], {}, keyOf)
  assert.strictEqual(empty.blocking.length, 2, 'with no accept-list, everything blocks')
  assert.strictEqual(loadAccepted(path.join(os.tmpdir(), 'no-such-accept-file.json')).accept &&
    Object.keys(loadAccepted(path.join(os.tmpdir(), 'no-such-accept-file.json')).accept).length, 0,
  'a missing file means nothing is accepted, not everything')
  ok('deny by default: no file and no entry both mean "blocks"')
}

// --- stale entries fail -----------------------------------------------------
// An entry whose finding no longer occurs makes the file claim a defect that is
// fixed. Reported so it gets pruned rather than accumulating.
{
  const accept = {
    [keyOf(finding())]: { disposition: 'wont-fix', note: 'known' },
    'refs:baked:cloud@ /cloud/gone {a} 3->2': { disposition: 'wont-fix', note: 'was true once' },
  }
  const res = applyAccepted([finding()], accept, keyOf)
  assert.deepStrictEqual(res.stale, ['refs:baked:cloud@ /cloud/gone {a} 3->2'],
    'an entry that matched nothing is reported stale')
  assert.strictEqual(res.accepted.length, 1, 'the entry that did match is still accepted')
  ok('applyAccepted: an entry whose finding is fixed is surfaced as stale')
}

// --- staleness is scope-aware -----------------------------------------------
// A scoped run (--component cloud) never sees another component's findings, so
// calling its entries stale would make every scoped run fail.
{
  const accept = {
    'refs:baked:cloud@ /cloud/x {a} 12->11': { disposition: 'wont-fix', note: 'k' },
    'refs:baked:operator@5.18 /operator/5.18/y {b} 2->1': { disposition: 'wont-fix', note: 'k' },
  }
  const inScope = (key) => key.includes(':cloud@')
  const res = applyAccepted([finding()], accept, keyOf, inScope)
  assert.deepStrictEqual(res.stale, [], 'an out-of-scope entry is not stale, merely not judged')
  ok('applyAccepted: staleness only judges entries the run could have matched')
}

// --- a reason is mandatory, and the vocabulary is closed --------------------
{
  assert.deepStrictEqual(validate({ k: { disposition: 'wont-fix', note: 'because' } }), [],
    'a well-formed entry validates')
  assert.strictEqual(validate({ k: { disposition: 'wont-fix' } }).length, 1, 'a missing note is an error')
  assert.strictEqual(validate({ k: { disposition: 'wont-fix', note: '   ' } }).length, 1, 'a blank note is an error')
  assert.strictEqual(validate({ k: { disposition: 'because-i-said-so', note: 'x' } }).length, 1,
    'a disposition outside the closed vocabulary is an error')
  assert.strictEqual(validate({ k: 'just a string' }).length, 1, 'a bare string is not an entry')
  assert(DISPOSITIONS.has('harness-limit') && DISPOSITIONS.has('deferred'), 'the vocabulary distinguishes WHY')
  ok('validate: an unexplained or mislabelled mute is a gate failure, not a silent pass')
}

// --- malformed file fails rather than accepting nothing silently -----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-selftest-'))
  const bad = path.join(dir, 'accepted.json')
  fs.writeFileSync(bad, '{ not json')
  const res = loadAccepted(bad)
  assert.strictEqual(res.errors.length, 1, 'unparseable JSON is reported as an error')
  assert.deepStrictEqual(res.accept, {}, 'and nothing is accepted from it')
  fs.rmSync(dir, { recursive: true, force: true })
  ok('loadAccepted: a broken file is an error, not an empty accept-list')
}

console.log(`\n[accepted selftest] ${n} groups passed.`)
