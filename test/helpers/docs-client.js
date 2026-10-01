'use strict'

module.exports = {
  useActivePluginAndVersion: () => globalThis.__hzTestClient.active,
  useDocsVersion: () => globalThis.__hzTestClient.docsVersion,
  useAllDocsData: () => globalThis.__hzTestClient.allDocsData ?? {},
}
