'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { pageMap } = require('..')

const docsPlugin = (versions) => ({ name: 'docusaurus-plugin-content-docs', content: { loadedVersions: versions } })

test('maps each doc source in every version and instance to its permalink', () => {
  const plugins = [
    docsPlugin([
      { docs: [{ source: '@site/hazelcast/sql/index.mdx', permalink: '/hazelcast/6.0-snapshot/sql' }] },
      { docs: [{ source: '@site/hazelcast_versioned_docs/version-5.7/sql/index.mdx', permalink: '/hazelcast/5.7/sql' }] },
    ]),
    docsPlugin([{ docs: [{ source: '@site/cloud/overview.mdx', permalink: '/cloud/overview' }] }]),
    { name: 'other-plugin', content: {} },
  ]
  assert.deepEqual(pageMap(plugins), {
    'hazelcast/sql/index.mdx': '/hazelcast/6.0-snapshot/sql',
    'hazelcast_versioned_docs/version-5.7/sql/index.mdx': '/hazelcast/5.7/sql',
    'cloud/overview.mdx': '/cloud/overview',
  })
})
