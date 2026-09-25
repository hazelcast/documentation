'use strict'

// The pages cutover must publish: every page of a live version of a migrated
// component, minus what an orphan decision withholds and the URLs a hand-written
// site page owns. The gates' `--strict` mode checks completeness against THIS set,
// read from the manifest, rather than against the golden: the golden also holds
// every frozen version, and a page that failed to render is simply absent from it.

const { NAV_SOURCES, NAVLESS, versionsToProcess, isSitePage } = require('./layout')
const { isUnpublished } = require('./dispositions')

// NAV_SOURCES alone is not the migrated set: a navless component (tutorials) is
// converted without a nav source.
const MIGRATED_COMPONENTS = [...Object.keys(NAV_SOURCES), ...NAVLESS]

function expectedPages (manifest, dispositions, components = MIGRATED_COMPONENTS) {
  const live = new Map(components.map((c) => [c, new Set(versionsToProcess(c).map((v) => v.seg || ''))]))
  return (manifest.resources || []).filter((r) =>
    r.family === 'page' && r.url &&
    live.has(r.component) && live.get(r.component).has(r.version || '') &&
    !isUnpublished(dispositions, r) && !isSitePage(r.url))
}

// The id build-snapshot.js records a failed render under (snapshot-errors.json).
const renderId = (r) => `${r.version || ''}@${r.component}:${r.module}:${r.relative}`

module.exports = { MIGRATED_COMPONENTS, expectedPages, renderId }
