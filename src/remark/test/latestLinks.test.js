'use strict'

// Spec: a `/<component>/latest/...` link in a page goes where the host's `/latest/` alias (static/_redirects)
// would send a reader, resolved at compile time so the broken-link checker can see the target.

const test = require('node:test')
const assert = require('node:assert/strict')
const {loadTs} = require('../../../test/helpers/load-ts')
const {loadDocsPlugins} = require('../../../test/helpers/docs-plugins')
const {follow} = require('../../../test/helpers/netlify-redirects')

const {default: latestLinks, resolveLatest} = loadTs('src/remark/latestLinks.ts')

const LATEST = {hazelcast: '5.7', clc: '5.5.1'}

test('a /latest/ path resolves to the same path under the aliased version', () => {
  assert.equal(resolveLatest('/hazelcast/latest/maps/overview', LATEST), '/hazelcast/5.7/maps/overview')
  assert.equal(resolveLatest('/clc/latest/install', LATEST), '/clc/5.5.1/install')
})

test('fragment and query survive the rewrite', () => {
  assert.equal(resolveLatest('/hazelcast/latest/maps#eviction', LATEST), '/hazelcast/5.7/maps#eviction')
  assert.equal(resolveLatest('/hazelcast/latest/maps?x=1#y', LATEST), '/hazelcast/5.7/maps?x=1#y')
})

test('the bare alias is the version root', () => {
  assert.equal(resolveLatest('/hazelcast/latest', LATEST), '/hazelcast/5.7/')
})

test('anything that is not a /latest/ link to a built component is left alone', () => {
  for (const url of [
    '/hazelcast/5.6/maps',
    '/hazelcast/latest-dev/maps',
    '/hazelcast/latestish/maps',
    '/imdg/latest/maps',
    'https://docs.hazelcast.com/hazelcast/latest/maps',
    '../latest/maps',
    'latest/maps',
    '#latest',
  ]) {
    assert.equal(resolveLatest(url, LATEST), null, url)
  }
})

const link = (url) => ({type: 'link', url, children: [{type: 'text', value: 'x'}]})
const jsxA = (href) => ({
  type: 'mdxJsxTextElement',
  name: 'a',
  attributes: [{type: 'mdxJsxAttribute', name: 'href', value: href}],
  children: [],
})

test('Markdown links and JSX <a href> anywhere in the tree are rewritten; other nodes are not', () => {
  const tree = {
    type: 'root',
    children: [
      {type: 'paragraph', children: [link('/hazelcast/latest/a'), {type: 'emphasis', children: [link('/clc/latest/b')]}]},
      {type: 'paragraph', children: [jsxA('/hazelcast/latest/c')]},
      {type: 'code', value: '/hazelcast/latest/in-code'},
      {type: 'mdxJsxTextElement', name: 'img', attributes: [{type: 'mdxJsxAttribute', name: 'href', value: '/hazelcast/latest/d'}], children: []},
    ],
  }
  latestLinks({latest: LATEST})(tree)
  const [p1, p2, code, img] = tree.children
  assert.equal(p1.children[0].url, '/hazelcast/5.7/a')
  assert.equal(p1.children[1].children[0].url, '/clc/5.5.1/b')
  assert.equal(p2.children[0].attributes[0].value, '/hazelcast/5.7/c')
  assert.equal(code.value, '/hazelcast/latest/in-code')
  assert.equal(img.attributes[0].value, '/hazelcast/latest/d')
})

test('the version map is read when a file compiles, not when the plugin is attached', () => {
  const latest = {}
  const transform = latestLinks({latest})
  latest.hazelcast = '5.7'
  const tree = {type: 'root', children: [link('/hazelcast/latest/a')]}
  transform(tree)
  assert.equal(tree.children[0].url, '/hazelcast/5.7/a')
})

test('for every versioned component, the compile-time resolution agrees with the host alias', () => {
  const {docsPlugins: {latestSegs}, configs} = loadDocsPlugins()
  assert.ok(Object.keys(latestSegs).length > 0, 'the site config registers versioned components')
  for (const id of Object.keys(latestSegs)) {
    for (const url of [`/${id}/latest/some/page`, `/${id}/latest`]) {
      assert.notEqual(follow(url), url, `static/_redirects has a /${id}/latest/* alias`)
      assert.equal(resolveLatest(url, latestSegs), follow(url), url)
    }
    // And the alias points at the version Docusaurus marks isLast (lastVersion), i.e. the one it treats as latest.
    const {lastVersion, versions} = configs[id]
    assert.equal(latestSegs[id], versions[lastVersion].path, `${id}: /latest/ is the lastVersion's segment`)
  }
})
