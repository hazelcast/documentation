'use strict'

// Examples a component does NOT keep in this repo: they belong to another repo,
// which builds and maintains them, and are fetched at build time into a shared
// staging dir (plugins/tutorial-examples). Two components use this today --
// `tutorials`, whose examples are the guide repos' project files, and `operator`,
// whose tutorial pages include example$ files from hazelcast-code-samples.
//
// The converter and the reference checker both have to agree on three things: what
// the staging dir is called, where a component's manifest lives, and how the path
// an include NAMES maps to the id the staged copy is addressed by. Written once
// here so they cannot drift -- refcheck reading a stale copy of this would report
// every staged import as one the page never asked for.

const fs = require('node:fs')
const path = require('node:path')

const { currentSegFor, outDirFor } = require('./layout')

// Gitignored, at the site root. Must match plugins/tutorial-examples.
const EXAMPLES_STAGING = '.tutorial-examples'

// ONE manifest per component, not one per version: the sources it names are not
// versioned per release, and every version's pages import the same staged file by
// the same site-absolute path. So it lives in the current version's dir, and every
// version reads it from there.
const referenceManifest = (component, outRoot) =>
  path.join(outDirFor(outRoot, component, { seg: currentSegFor(component), kind: 'current' }), 'examples.json')

function readManifest (component, outRoot) {
  try {
    return JSON.parse(fs.readFileSync(referenceManifest(component, outRoot), 'utf8'))
  } catch {
    return null
  }
}

// Source path -> staged id. An include addresses a cross-component example by its
// path in the repo that owns it, which is exactly the manifest's `path`; the staged
// file is addressed by `id`. Same file, two names.
function stagedIdsByPath (component, outRoot) {
  const byPath = new Map()
  const manifest = readManifest(component, outRoot)
  for (const f of (manifest && manifest.files) || []) byPath.set(f.path, f.id)
  return byPath
}

// Tag specs recorded by extract-examples that a file's own markers cannot reveal
// (lists, negations) -- the converter's content index needs them to match at all.
const manifestSelectors = (component, outRoot) => {
  const manifest = readManifest(component, outRoot)
  return (manifest && manifest.selectors) || []
}

// The staged id an import path addresses, or null if it is not a staged import.
// Checked BEFORE the co-located `/examples/` rule, because a staged path usually
// contains `/examples/` too -- it is a path inside the owning repo's own docs tree
// -- and splitting on that yields a bare filename that matches nothing.
function stagedRel (file) {
  const norm = String(file).split(path.sep).join('/')
  const marker = `/${EXAMPLES_STAGING}/`
  const i = norm.indexOf(marker)
  return i === -1 ? null : norm.slice(i + marker.length)
}

module.exports = { EXAMPLES_STAGING, referenceManifest, stagedIdsByPath, manifestSelectors, stagedRel }
