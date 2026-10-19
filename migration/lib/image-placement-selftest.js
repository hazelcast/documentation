'use strict'

// Unit self-test for lib/image-placement.js -- the plan that decides where a
// co-located image FILE lands. The converter emits references against this plan
// and extract-images.js writes bytes against it, so a bug here corrupts both in
// the SAME way: the reference still resolves, the build still passes, and the
// page just shows a different picture. Pure logic, no fs. Run:
//   node lib/image-placement-selftest.js

const assert = require('node:assert')
const path = require('node:path')

const { IMAGES_DIR, commonAncestorDir, imageTail, planImagePlacement, mergePlacements } = require('./image-placement')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// Independent oracle for commonAncestorDir: brute-force every prefix of the
// first directory and take the longest one that prefixes them all. Written from
// the DEFINITION of "deepest common ancestor" rather than from the
// implementation, so the two can disagree.
function oracleAncestor (dirs) {
  const list = [...dirs]
  const first = list[0] ? list[0].split('/') : []
  let best = ''
  for (let i = 0; i <= first.length; i++) {
    const cand = first.slice(0, i).join('/')
    const isAncestor = (d) => d === cand || (cand === '' ? true : (d + '/').startsWith(cand + '/'))
    if (list.every(isAncestor) && cand.length >= best.length) best = cand
  }
  return best
}

// --- commonAncestorDir ------------------------------------------------------
{
  const cases = [
    ['cluster'],
    ['cluster', 'cluster'],
    ['cluster/administration', 'cluster/administration/persistence'],
    ['cluster/administration', 'cluster/client-filtering'],
    ['tools', 'storage-compute-messaging'],
    ['', 'tools'],
    [''],
    ['deploy-and-manage/security/tls', 'deploy-and-manage/security/user-authentication'],
    // A directory whose NAME prefixes another's must not count as its ancestor:
    // "cluster" is not an ancestor of "cluster-connections".
    ['cluster', 'cluster-connections'],
  ]
  for (const dirs of cases) {
    assert.strictEqual(commonAncestorDir(dirs), oracleAncestor(dirs),
      `commonAncestorDir(${JSON.stringify(dirs)}) must match the oracle`)
  }
  assert.strictEqual(commonAncestorDir(['cluster', 'cluster-connections']), '',
    'a shared name PREFIX is not a shared ancestor (cluster vs cluster-connections)')
  assert.strictEqual(commonAncestorDir([]), '', 'no consumers -> the tree root')
  ok('commonAncestorDir: agrees with an independent deepest-common-prefix oracle')
}

// --- imageTail: what gets re-rooted under the destination images/ folder -----
{
  assert.strictEqual(imageTail('/cloud/_images/foo.png'), 'foo.png',
    'a flat image keeps its file name')
  assert.strictEqual(imageTail('/hazelcast/5.7/wan/_images/wan/cluster-connected.png'), 'wan/cluster-connected.png',
    'a subdirectory under _images survives (hz-docs wan/images/wan/*) rather than flattening')
  assert.strictEqual(imageTail('/x/y/z.png'), 'z.png',
    'a URL with no _images segment falls back to the file name')
  ok('imageTail: keeps the authored path below _images, so nested images cannot collide')
}

// --- planImagePlacement: the property that makes ONE copy sufficient ---------
// A single co-located file can serve every consumer only if it sits in an
// `images/` folder of a directory that is an ancestor-or-self of ALL of them.
// Assert that property directly, plus maximality (nothing shallower than it has
// to be), rather than restating the chosen paths.
{
  const refs = [
    { url: '/mc/5.11/_images/Dashboard.png', dir: 'cluster' },
    { url: '/mc/5.11/_images/Dashboard.png', dir: 'cluster/administration' },
    { url: '/mc/5.11/_images/Sql.png', dir: 'tools' },
    { url: '/mc/5.11/_images/Wide.png', dir: 'tools' },
    { url: '/mc/5.11/_images/Wide.png', dir: 'streaming' },
    { url: '/mc/5.11/_images/Root.png', dir: '' },
  ]
  const plan = planImagePlacement(refs)

  const consumersOf = (url) => refs.filter((r) => r.url === url).map((r) => r.dir)
  for (const [url, dest] of plan) {
    const up = path.posix.dirname(path.posix.dirname(dest))
    const destDir = up === '.' ? '' : up
    assert.strictEqual(path.posix.basename(path.posix.dirname(dest)), IMAGES_DIR,
      `${url} must land in an ${IMAGES_DIR}/ folder`)
    for (const c of consumersOf(url)) {
      assert(c === destDir || (destDir === '' ? true : (c + '/').startsWith(destDir + '/')),
        `${dest} must sit at or above its consumer ${c || '<root>'}`)
    }
    assert.strictEqual(destDir, oracleAncestor(consumersOf(url)),
      `${url} must be as DEEP as its consumers allow, not parked at the root`)
  }

  assert.strictEqual(plan.get('/mc/5.11/_images/Sql.png'), 'tools/images/Sql.png',
    'a single-consumer image (166 of MC\'s 170) lands beside the page that uses it')
  assert.strictEqual(plan.get('/mc/5.11/_images/Wide.png'), 'images/Wide.png',
    'consumers with no shared ancestor fall back to the tree root')
  ok('planImagePlacement: every image sits at, and no higher than, its consumers\' common ancestor')
}

// --- collisions are refused, not silently resolved --------------------------
// Two different images written to one path would leave one set of pages showing
// the other's picture -- a wrong-but-resolvable reference, which is exactly what
// no fidelity layer could see before imageNames (fidelity/lib/structure.js).
{
  assert.throws(
    () => planImagePlacement([
      { url: '/mc/5.11/ROOT/_images/Same.png', dir: 'tools' },
      { url: '/mc/5.11/tools/_images/Same.png', dir: 'tools' },
    ]),
    /two images would be written to/,
    'two images resolving to one destination must throw, not overwrite'
  )
  // The same image referenced from several pages is NOT a collision.
  assert.doesNotThrow(() => planImagePlacement([
    { url: '/mc/5.11/_images/A.png', dir: 'tools' },
    { url: '/mc/5.11/_images/A.png', dir: 'tools' },
  ]), 'one image with repeated references is fine')
  ok('planImagePlacement: refuses a destination collision instead of overwriting')
}

// --- determinism ------------------------------------------------------------
// Both the converter and extract-images act on this plan, and a full run is
// expected to be idempotent (zero git churn when nothing changed upstream), so
// reference order must not move a file.
{
  const a = [
    { url: '/c/_images/x.png', dir: 'b/c' },
    { url: '/c/_images/y.png', dir: 'a' },
    { url: '/c/_images/x.png', dir: 'b' },
  ]
  const b = [a[2], a[1], a[0]]
  assert.deepStrictEqual([...planImagePlacement(a)].sort(), [...planImagePlacement(b)].sort(),
    'the plan must not depend on the order references are collected in')
  ok('planImagePlacement: deterministic regardless of reference order')
}

// --- SPEC: a run replaces only the copies in the trees it wrote ------------
// A tutorial shows a Cloud image; reconverting Cloud must not drop the tutorial's
// copy, and one image placed in two products keeps both copies.
{
  const before = {
    'cloud/images/a.png': '/cloud/_images/a.png',
    'cloud/images/old.png': '/cloud/_images/old.png',
    'tutorials/images/maploader.png': '/cloud/_images/maploader.png',
  }
  const after = mergePlacements(before, ['cloud/', 'cloud_versioned_docs/'], [
    ['cloud/images/a.png', '/cloud/_images/a.png'],
    ['cloud/x/images/maploader.png', '/cloud/_images/maploader.png'],
  ])
  assert.deepStrictEqual(after, {
    'cloud/images/a.png': '/cloud/_images/a.png',
    'cloud/x/images/maploader.png': '/cloud/_images/maploader.png',
    'tutorials/images/maploader.png': '/cloud/_images/maploader.png',
  }, 'Cloud\'s stale copy goes, the tutorial\'s copy of a Cloud image stays, and both copies of the shared image exist')
  ok('mergePlacements: a run owns the trees it writes, not the images\' home product')
}

console.log(`\n[image-placement selftest] ${n} groups passed.`)
