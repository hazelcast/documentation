'use strict'

// Works out where a change made in one version's folder goes in other versions of the same product. It reads no files, so it can be tested on its own.

const {versionLink} = require('../../.github/scripts/version-update/files')

const REWRITTEN_FILE = /\.mdx?$/
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// state: {current: src/currentVersions.json, releases: {<product>: <product>_versions.json}}. `version` is 'current' or a release.
const seg = (state, product, version) => (version === 'current' ? state.current[product].currentSeg : version)
const docsDir = (product, version) => (version === 'current' ? product : `${product}_versioned_docs/version-${version}`)

// What a version name on the command line means for a product: 'current' (also accepted as main's segment), a release, or null.
function resolveVersion (state, product, name) {
  if (name === 'current' || name === state.current[product].currentSeg) return 'current'
  return state.releases[product].includes(name) ? name : null
}

// The product, version, and path within the version of a file, or null for a file outside every version's folder.
function locate (state, file) {
  const parts = file.split('/')
  const [first, second, third] = parts
  if (first === 'static' && state.current[second] && parts.length > 3) {
    const version = resolveVersion(state, second, third)
    return version && {product: second, version, static: true, rest: parts.slice(3).join('/')}
  }
  if (state.current[first] && parts.length > 1) return {product: first, version: 'current', static: false, rest: parts.slice(1).join('/')}
  const product = first.endsWith('_versioned_docs') && first.slice(0, -'_versioned_docs'.length)
  if (product && state.current[product] && second?.startsWith('version-') && parts.length > 2) {
    return {product, version: second.slice('version-'.length), static: false, rest: parts.slice(2).join('/')}
  }
  return null
}

function relocate (state, {product, static: isStatic, rest}, version) {
  return isStatic ? `static/${product}/${seg(state, product, version)}/${rest}` : `${docsDir(product, version)}/${rest}`
}

// Rewrites a page's own-version imports and links, as the release script does when it copies main into a release.
function rewriter (state, product, from, to) {
  const imports = new RegExp(`@site/${escape(docsDir(product, from))}/`, 'g')
  const link = versionLink(product, seg(state, product, from))
  const toImports = `@site/${docsDir(product, to)}/`
  const toSeg = seg(state, product, to)
  return (file, text) => (REWRITTEN_FILE.test(file) ? text.replace(imports, toImports).replace(link, `$1$2${toSeg}`) : text)
}

// changes: [{status: 'A' | 'M' | 'D' | 'R', path, oldPath (R only)}]. Throws when the request is ambiguous or names no real version.
function planBackport (state, changes, {targets, from}) {
  if (!targets.length) throw new Error('Name at least one version to apply the change to')
  const ignored = []
  const notes = []
  const byProduct = new Map()
  for (const change of changes) {
    const loc = locate(state, change.path)
    const oldLoc = change.oldPath ? locate(state, change.oldPath) : loc
    if (!loc || !oldLoc || loc.product !== oldLoc.product || loc.version !== oldLoc.version) {
      ignored.push(change.path)
      continue
    }
    if (!byProduct.has(loc.product)) byProduct.set(loc.product, [])
    byProduct.get(loc.product).push({change, loc, oldLoc})
  }

  if (from && ![...byProduct.keys()].some((product) => resolveVersion(state, product, from))) {
    throw new Error(`No product you changed has a version '${from}'`)
  }
  for (const target of targets) {
    if (![...byProduct.keys()].some((product) => resolveVersion(state, product, target))) {
      throw new Error(`No product you changed has a version '${target}'`)
    }
  }

  const jobs = []
  for (const [product, entries] of byProduct) {
    let source
    if (from) {
      source = resolveVersion(state, product, from)
      if (!source) {
        notes.push(`${product}: has no version '${from}', so its changes were left alone`)
        continue
      }
    } else {
      const versions = [...new Set(entries.map(({loc}) => loc.version))]
      if (versions.length > 1) {
        const names = versions.map((v) => seg(state, product, v)).join(', ')
        throw new Error(`${product} has changes in more than one version (${names}). Use --from to say which version's changes to apply.`)
      }
      source = versions[0]
    }
    const sourceEntries = entries.filter(({loc}) => loc.version === source)
    for (const target of targets) {
      const version = resolveVersion(state, product, target)
      if (!version) notes.push(`${product}: has no version '${target}'`)
      else if (version === source) notes.push(`${product} ${seg(state, product, version)}: is where the change was made`)
      else if (!jobs.some((job) => job.product === product && job.to === version)) {
        jobs.push({
          product,
          from: source,
          to: version,
          fromSeg: seg(state, product, source),
          toSeg: seg(state, product, version),
          files: sourceEntries.map(({change, loc, oldLoc}) => ({
            status: change.status,
            source: change.path,
            sourceOld: change.oldPath,
            target: relocate(state, loc, version),
            targetOld: change.oldPath && relocate(state, oldLoc, version),
          })),
        })
      }
    }
  }
  return {jobs, ignored, notes}
}

module.exports = {planBackport, rewriter, locate, relocate, resolveVersion}
