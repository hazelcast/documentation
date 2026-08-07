'use strict'

// Shared layout/source config for the migration tooling: which source repo +
// branch a component's pages come from, which versions are emitted, and where
// (and under what slug) each converted page lands. Single-sourced here so the
// converter (converter/convert.js) and the reference checker (refcheck/run.js)
// resolve sources and output paths identically -- they must never drift.

const path = require('node:path')

// The version segment the current (main/-snapshot) branch is published under.
// Antora serves main at `/<component>/latest-snapshot/…`, so that is also the
// golden/manifest version key AND the Docusaurus current-version `path`.
const CURRENT_SEG = 'latest-snapshot'

// Component -> source repo mirror (under .sources/), the nav.adoc path, and how
// to pick the branch for a version segment. A versioned component reads a
// different branch per segment (`refFor`); an unversioned one has a plain `ref`.
const NAV_SOURCES = {
  cloud: { repo: 'cloud-docs.git', ref: 'main', file: 'docs/modules/ROOT/nav.adoc' },
  operator: {
    repo: 'hazelcast-platform-operator-docs.git',
    file: 'docs/modules/ROOT/nav.adoc',
    refFor: (seg) => (seg === CURRENT_SEG ? 'main' : `v/${seg}`),
  },
}

// Live version set per versioned component: the current (main) branch plus the
// released versions cut into `<component>_versioned_docs`. Newest release first.
// Phase 1 warms up on operator with just the newest release; scale by extending
// `releases` (and docusaurus.config.ts onlyIncludeVersions) together. Older
// releases are frozen as static HTML outside this build (freeze plan), so they
// are deliberately absent here.
const VERSIONS = {
  operator: { releases: ['5.18'] },
}

// Attributes whose references are MARKED in the golden (antora-extension/
// mark-attributes.js) and turned back into <Variable> by the converter, per
// component. Use this — rather than the value-based reverse-map — for attributes
// whose resolved value is an ambiguous word that cannot be safely told apart
// from a literal in rendered HTML (e.g. hazelcast-cloud -> "Cloud", where the
// page also says "Confluent Cloud"). The marker gives the exact positions, so
// only genuine references are variableised. Values are single-sourced into
// variables.ts exactly like the SINGLE_SOURCE set.
const MARKED_ATTRS = {
  cloud: ['hazelcast-cloud'],
}

// The marked-attribute names for a component (empty array if none).
const markedAttrsFor = (component) => MARKED_ATTRS[component] || []

// A component is "versioned" (values nested per version) exactly when it appears
// in VERSIONS; otherwise its single value is global. Mirrors versionsToProcess.
const isVersioned = (component) => Object.prototype.hasOwnProperty.call(VERSIONS, component)

// The branch (git ref) a component's source is read from for a version segment.
const refFor = (component, seg) => {
  const src = NAV_SOURCES[component]
  if (!src) return null
  return src.refFor ? src.refFor(seg) : src.ref
}

// The versions to emit for a component, in processing order. Unversioned
// components yield a single pass with `seg === null`. Versioned ones yield the
// current (main) branch first, then each live release. `kind` drives where the
// tree lands and whether it is the plugin's current or a versioned copy.
function versionsToProcess (component, releasesOverride) {
  const cfg = VERSIONS[component]
  if (!cfg) return [{ seg: null, kind: 'unversioned' }]
  const releases = releasesOverride || cfg.releases
  return [
    { seg: CURRENT_SEG, kind: 'current' },
    ...releases.map((seg) => ({ seg, kind: 'release' })),
  ]
}

// Where a (component, version) tree is written.
//   unversioned / current -> ../<component>                       (plugin path)
//   release X             -> ../<component>_versioned_docs/version-X
function outDirFor (outRoot, component, { seg, kind }) {
  if (kind === 'release') return path.join(outRoot, `${component}_versioned_docs`, `version-${seg}`)
  return path.join(outRoot, component)
}

// A page's site URL -> the `slug` it must carry to preserve that URL. The slug
// is relative to the plugin instance's version base (routeBasePath + version
// path), so we strip the `/<component>[/<seg>]` prefix and keep the remainder
// verbatim — which preserves module segments (operator's `tutorials/` pages)
// that a stem-only slug would drop. A version root (`/operator/5.18/`) -> `/`.
function urlToSlug (url, component, seg) {
  const prefix = '/' + component + (seg ? '/' + seg : '')
  let s = url.startsWith(prefix) ? url.slice(prefix.length) : url
  if (s.length > 1) s = s.replace(/\/$/, '') // drop trailing slash (trailingSlash:false), except root
  if (s === '' || s === '/') return '/'
  return s.startsWith('/') ? s : '/' + s
}

module.exports = {
  CURRENT_SEG,
  NAV_SOURCES,
  VERSIONS,
  MARKED_ATTRS,
  markedAttrsFor,
  isVersioned,
  refFor,
  versionsToProcess,
  outDirFor,
  urlToSlug,
}
