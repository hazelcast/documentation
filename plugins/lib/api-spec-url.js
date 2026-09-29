'use strict'

// Where an OpenAPI spec is published: /<component>/<version>/_attachments/swagger/<file>.yaml.
// That URL is reader-facing (Redoc's "Download OpenAPI specification" link), so keep it stable.
// Shared by the staging plugin (plugins/openapi-specs) and the renderer (src/components/ApiReference).

const SWAGGER_DIR = '_attachments/swagger'

function specFileName (source) {
  return source.split('/').pop().split('?')[0]
}

// `versionBase` is the version's base URL, or '/<component>' for an unversioned component.
function specUrlFor (versionBase, source) {
  return `${versionBase.replace(/\/+$/, '')}/${SWAGGER_DIR}/${specFileName(source)}`
}

module.exports = { SWAGGER_DIR, specFileName, specUrlFor }
