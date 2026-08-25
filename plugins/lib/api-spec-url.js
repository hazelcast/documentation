'use strict'

// Where an OpenAPI spec is published, and under what name.
//
// Antora's swagger_ui macro publishes each fetched spec as a component
// ATTACHMENT -- /<component>/<version>/_attachments/swagger/<file>.yaml -- and
// that URL is reader-facing, not an internal detail: Redoc renders a "Download
// OpenAPI specification" button linking straight to it, so anyone who fed the
// spec to a client generator has it written down. It is preserved verbatim.
//
// Shared by the plugin that STAGES the file (plugins/openapi-specs) and the
// component that RENDERS it (src/components/ApiReference), so the writer and the
// reader cannot disagree about where a spec lives.

const SWAGGER_DIR = '_attachments/swagger'

// The attachment's basename is the source file's own name, as Antora does.
function specFileName (source) {
  return source.split('/').pop().split('?')[0]
}

// `versionBase` is the docs version's base URL ('/management-center/5.11'), which
// for an unversioned component is just '/<component>' -- matching Antora, which
// omits the segment when a component has no version.
function specUrlFor (versionBase, source) {
  return `${versionBase.replace(/\/+$/, '')}/${SWAGGER_DIR}/${specFileName(source)}`
}

module.exports = { SWAGGER_DIR, specFileName, specUrlFor }
