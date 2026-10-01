'use strict'

// Spec: every operation on an API reference page publishes a readable anchor built from its method and path, every
// anchor Redoc puts on the page stays linkable, and two operations that would share an anchor are reported.
// Redoc's own menu model is built from a real spec as the build does; expected operations are enumerated
// independently from the spec's `paths`.

const test = require('node:test')
const assert = require('node:assert/strict')
const {HTTP_METHODS, operationAnchor, menuItemAnchor, menuAnchors, anchorCollisions} = require('../api-anchors')

async function storeFor (spec) {
  const {loadAndBundleSpec, AppStore} = require('redoc')
  const bundled = await loadAndBundleSpec(structuredClone(spec))
  return new AppStore(bundled, undefined, {disableSearch: true}, false)
}

const SPEC = {
  openapi: '3.0.3',
  info: {title: 'Test', version: '1', description: '# Intro\n\nText.'},
  tags: [{name: 'Clusters'}, {name: 'Maps'}],
  paths: {
    '/rest/clusters/{clusterName}': {
      summary: 'not an operation',
      parameters: [{name: 'clusterName', in: 'path', required: true, schema: {type: 'string'}}],
      get: {tags: ['Clusters'], summary: 'Get a cluster', operationId: 'getCluster', responses: {200: {description: 'ok'}}},
      delete: {tags: ['Clusters'], summary: 'Delete a cluster', responses: {204: {description: 'gone'}}},
    },
    '/rest/maps': {
      post: {tags: ['Maps'], summary: 'Create a map', responses: {201: {description: 'made'}}},
    },
  },
}

const operationsOf = (spec) =>
  Object.entries(spec.paths).flatMap(([p, item]) =>
    Object.keys(item).filter((k) => HTTP_METHODS.includes(k)).map((method) => ({method, path: p})))

test('the operation keys are exactly the OpenAPI 3 path-item operation fields', () => {
  assert.deepEqual([...HTTP_METHODS].sort(), ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'])
})

test('an operation anchor is its method and path, lowercased, with punctuation runs as single hyphens', () => {
  assert.equal(operationAnchor('get', '/rest/clusters/{clusterName}'), 'get-rest-clusters-clustername')
  assert.equal(operationAnchor('POST', '/a/{b}/c'), 'post-a-b-c')
  assert.equal(operationAnchor('get', '/'), 'get')
})

test('every operation in the spec is published under its method+path anchor', async () => {
  const anchors = new Set(menuAnchors(await storeFor(SPEC)))
  for (const {method, path} of operationsOf(SPEC)) {
    assert.ok(anchors.has(operationAnchor(method, path)), `${method} ${path}`)
  }
})

test('Redoc\'s own item ids are published too, so existing inbound links keep resolving', async () => {
  const store = await storeFor(SPEC)
  const anchors = new Set(menuAnchors(store))
  const ids = store.menu.flatItems.map((item) => item.id).filter(Boolean)
  assert.ok(ids.length > operationsOf(SPEC).length, 'the menu has tag and description items as well as operations')
  for (const id of ids) assert.ok(anchors.has(id), id)
})

test('the anchor a menu item renders with is one the page publishes', async () => {
  const store = await storeFor(SPEC)
  const anchors = new Set(menuAnchors(store))
  for (const item of store.menu.flatItems) assert.ok(anchors.has(menuItemAnchor(item)), item.id)
})

test('distinct operations get distinct anchors, and a spec with none colliding reports no collisions', async () => {
  const store = await storeFor(SPEC)
  const ops = store.menu.flatItems.filter((i) => i.type === 'operation').map(menuItemAnchor)
  assert.equal(new Set(ops).size, operationsOf(SPEC).length)
  assert.deepEqual(anchorCollisions(store), [])
})

test('two operations whose paths differ only in punctuation are reported as a collision, naming both', async () => {
  const ok = {responses: {200: {description: 'ok'}}}
  const store = await storeFor({
    openapi: '3.0.3',
    info: {title: 'T', version: '1'},
    paths: {'/a-b': {get: ok}, '/a/b': {get: ok}, '/c': {get: ok}},
  })
  const collisions = anchorCollisions(store)
  assert.equal(collisions.length, 1)
  assert.equal(collisions[0].anchor, 'get-a-b')
  assert.deepEqual([...collisions[0].items].sort(), ['get /a-b', 'get /a/b'])
})
