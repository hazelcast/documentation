'use strict'

module.exports = {
  useActivePluginAndVersion: () => globalThis.__hzTestClient.active,
  useDocsVersion: () => globalThis.__hzTestClient.docsVersion,
}
