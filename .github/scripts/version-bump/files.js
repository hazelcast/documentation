'use strict'

// Applies planBump's ops to a checkout. A file that does not round-trip byte for byte is refused, never reformatted.

const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')

const CURRENT_VERSIONS = 'src/currentVersions.json'
const VARIABLES = 'src/variables.ts'
const REDIRECTS = 'src/redirects.ts'
const NETLIFY_REDIRECTS = 'static/_redirects'
const VARIABLES_START = 'export const versionedVariables: Record<string, Record<string, Record<string, string>>> = '
const REDIRECTS_START = 'export const redirects: {from: string; to: string}[] = [\n'
const REDIRECT_LINE = /^ {2}\{ from: ("(?:[^"\\]|\\.)*"), to: ("(?:[^"\\]|\\.)*") \},$/
const TEXT_FILE = /\.(mdx?|json|ya?ml|js|ts|tsx|jsx)$/
const REWRITTEN_FILE = /\.mdx?$/

const releasesFile = (component) => `${component}_versions.json`
const versionDir = (component, version) => `${component}_versioned_docs/version-${version}`
const json = (value) => JSON.stringify(value, null, 2) + '\n'

function read (siteDir, file) {
  return fs.readFileSync(path.join(siteDir, file), 'utf8')
}

function write (siteDir, file, text) {
  fs.writeFileSync(path.join(siteDir, file), text)
}

function refuseUnlessRoundTrips (file, original, rebuilt) {
  if (original !== rebuilt) {
    throw new Error(`${file} is not in the format the version bump writes; refusing to rewrite it`)
  }
}

function parseVariables (text) {
  const start = text.indexOf(VARIABLES_START)
  if (start === -1) throw new Error(`${VARIABLES}: no versionedVariables declaration`)
  const bodyStart = start + VARIABLES_START.length
  const bodyEnd = text.indexOf('\n};', bodyStart) + 2
  const body = text.slice(bodyStart, bodyEnd)
  const variables = JSON.parse(body)
  const serialize = (value) => text.slice(0, bodyStart) + JSON.stringify(value, null, 2) + text.slice(bodyEnd)
  refuseUnlessRoundTrips(VARIABLES, text, serialize(variables))
  return {variables, serialize}
}

function parseRedirects (text) {
  const start = text.indexOf(REDIRECTS_START)
  if (start === -1) throw new Error(`${REDIRECTS}: no redirects declaration`)
  const head = text.slice(0, start + REDIRECTS_START.length)
  const tail = '];\n'
  const lines = text.slice(head.length, text.length - tail.length).split('\n').filter(Boolean)
  const entries = lines.map((line) => {
    const m = REDIRECT_LINE.exec(line)
    if (!m) throw new Error(`${REDIRECTS}: unexpected line: ${line}`)
    return {from: JSON.parse(m[1]), to: JSON.parse(m[2])}
  })
  const serialize = (list) => {
    const out = list.map(({from, to}) => `  { from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)} },`).sort()
    return head + out.map((line) => line + '\n').join('') + tail
  }
  refuseUnlessRoundTrips(REDIRECTS, text, serialize(entries))
  return {entries, serialize}
}

function readState (siteDir) {
  const current = JSON.parse(read(siteDir, CURRENT_VERSIONS))
  refuseUnlessRoundTrips(CURRENT_VERSIONS, read(siteDir, CURRENT_VERSIONS), json(current))
  const releases = {}
  for (const component of Object.keys(current)) {
    const text = read(siteDir, releasesFile(component))
    releases[component] = JSON.parse(text)
    refuseUnlessRoundTrips(releasesFile(component), text, json(releases[component]))
  }
  const {variables} = parseVariables(read(siteDir, VARIABLES))
  return {current, releases, variables}
}

function trackedFiles (siteDir, dir) {
  return execFileSync('git', ['-C', siteDir, 'ls-files', '-z', '--', dir], {encoding: 'utf8'})
    .split('\0')
    .filter(Boolean)
}

// /hazelcast/6.0-snapshot/… or https://docs.hazelcast.com/hazelcast/6.0-snapshot/…, not /hazelcast/6.0-snapshot-x or /x/hazelcast/6.0-snapshot.
function versionLink (component, seg) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w./-]|https://docs\\.hazelcast\\.com)(/${escape(component)}/)${escape(seg)}(?=[/#?"'\`)\\]\\s>]|$)`, 'g')
}

function rewriteFiles (siteDir, files, rewrite) {
  for (const file of files) {
    if (!REWRITTEN_FILE.test(file)) continue
    const text = read(siteDir, file)
    const next = rewrite(text)
    if (next !== text) write(siteDir, file, next)
  }
}

function assertNoneLeft (siteDir, files, pattern, what) {
  const left = files.filter((file) => TEXT_FILE.test(file) && new RegExp(pattern.source).test(read(siteDir, file)))
  if (left.length) throw new Error(`${what} left in: ${left.join(', ')}`)
}

function assertImportsResolve (siteDir, files) {
  const missing = []
  for (const file of files.filter((f) => REWRITTEN_FILE.test(f))) {
    for (const [, target] of read(siteDir, file).matchAll(/from ['"]@site\/([^'"?]+)(?:\?[^'"]*)?['"]/g)) {
      if (!['', '.mdx', '.md', '.js', '.jsx', '.ts', '.tsx'].some((ext) => fs.existsSync(path.join(siteDir, target + ext)))) {
        missing.push(`${file}: @site/${target}`)
      }
    }
  }
  if (missing.length) throw new Error(`Unresolved imports in the copy:\n  ${missing.join('\n  ')}`)
}

function copyCurrent (siteDir, component, version, fromSeg) {
  const dest = versionDir(component, version)
  if (fs.existsSync(path.join(siteDir, dest))) throw new Error(`${dest} already exists`)
  const copied = []
  for (const file of trackedFiles(siteDir, component)) {
    const target = path.join(dest, path.relative(component, file))
    fs.mkdirSync(path.dirname(path.join(siteDir, target)), {recursive: true})
    fs.copyFileSync(path.join(siteDir, file), path.join(siteDir, target))
    copied.push(target)
  }
  if (!copied.length) throw new Error(`No tracked files under ${component}/`)
  const ownImports = new RegExp(`@site/${component}/`, 'g')
  const link = versionLink(component, fromSeg)
  rewriteFiles(siteDir, copied, (text) => text.replace(ownImports, `@site/${dest}/`).replace(link, `$1$2${version}`))
  assertNoneLeft(siteDir, copied, ownImports, `Imports of @site/${component}/`)
  assertNoneLeft(siteDir, copied, link, `Links to /${component}/${fromSeg}`)
  assertImportsResolve(siteDir, copied)
  return copied.length
}

// static/<component>/<seg>/ (the Antora attachment) is served at the version's URLs, so it follows the segment.
function staticFilesUnder (siteDir, component, seg) {
  return trackedFiles(siteDir, `static/${component}/${seg}`)
}

function copyStatic (siteDir, component, fromSeg, toSeg, {move = false} = {}) {
  const files = staticFilesUnder(siteDir, component, fromSeg)
  const from = `static/${component}/${fromSeg}`
  const to = `static/${component}/${toSeg}`
  if (files.length && fs.existsSync(path.join(siteDir, to))) throw new Error(`${to} already exists`)
  for (const file of files) {
    const target = path.join(siteDir, to, path.relative(from, file))
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.copyFileSync(path.join(siteDir, file), target)
  }
  if (move && files.length) fs.rmSync(path.join(siteDir, from), {recursive: true})
  return files.length
}

function underSeg (url, component, seg) {
  const base = `/${component}/${seg}`
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}#`)
}

function reseg (url, component, fromSeg, toSeg) {
  return `/${component}/${toSeg}` + url.slice(`/${component}/${fromSeg}`.length)
}

// Page aliases under a segment. One crossing the segment boundary is unexpected, so it stops the bump.
function redirectsUnder (entries, component, seg) {
  const under = entries.filter(({from, to}) => underSeg(from, component, seg) || underSeg(to, component, seg))
  const mixed = under.filter(({from, to}) => !(underSeg(from, component, seg) && underSeg(to, component, seg)))
  if (mixed.length) {
    throw new Error(`${REDIRECTS}: redirects crossing /${component}/${seg}: ${mixed.map((e) => `${e.from} -> ${e.to}`).join(', ')}`)
  }
  return under
}

function setLatestRedirects (text, component, latest, latestDev) {
  const lines = text.split('\n')
  const replace = (prefix, target) => {
    const i = lines.findIndex((line) => line.startsWith(`${prefix} `))
    if (i === -1) throw new Error(`${NETLIFY_REDIRECTS}: no '${prefix}' rule`)
    lines[i] = lines[i].replace(new RegExp(`(\\s+/${component}/)[^/]+`), `$1${target}`)
  }
  replace(`/${component}/latest/*`, latest)
  replace(`/${component}/latest-dev/*`, latestDev)
  return lines.join('\n')
}

function applyOps (siteDir, ops) {
  const log = []
  const currentText = read(siteDir, CURRENT_VERSIONS)
  const current = JSON.parse(currentText)
  const variablesFile = parseVariables(read(siteDir, VARIABLES))
  const variables = variablesFile.variables
  const redirectsFile = parseRedirects(read(siteDir, REDIRECTS))
  let redirects = redirectsFile.entries
  let netlify = read(siteDir, NETLIFY_REDIRECTS)
  const releases = {}
  const touched = new Set()

  for (const op of ops) {
    if (op.op === 'setVars') {
      Object.assign(variables[op.component][op.version], op.values)
      touched.add(VARIABLES)
      log.push(`${VARIABLES}: ${op.component} ${op.version}: ${Object.entries(op.values).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    } else if (op.op === 'addRelease') {
      const n = copyCurrent(siteDir, op.component, op.version, op.fromSeg)
      log.push(`${versionDir(op.component, op.version)}/: ${n} files copied from ${op.component}/`)
      const s = copyStatic(siteDir, op.component, op.fromSeg, op.version)
      if (s) log.push(`static/${op.component}/${op.version}/: ${s} files copied from static/${op.component}/${op.fromSeg}/`)
      const file = releasesFile(op.component)
      releases[file] = [op.version, ...(releases[file] ?? JSON.parse(read(siteDir, file)))]
      log.push(`${file}: added ${op.version}`)
      const {current: currentVars, ...rest} = variables[op.component]
      variables[op.component] = {current: currentVars, [op.version]: {...op.variables}, ...rest}
      touched.add(VARIABLES)
      log.push(`${VARIABLES}: ${op.component} ${op.version} added`)
      const cloned = redirectsUnder(redirects, op.component, op.fromSeg).map(({from, to}) => ({
        from: reseg(from, op.component, op.fromSeg, op.version),
        to: reseg(to, op.component, op.fromSeg, op.version),
      }))
      redirects = [...redirects, ...cloned]
      touched.add(REDIRECTS)
      log.push(`${REDIRECTS}: ${cloned.length} page aliases copied to ${op.component} ${op.version}`)
    } else if (op.op === 'setCurrent') {
      const files = trackedFiles(siteDir, op.component)
      const link = versionLink(op.component, op.fromSeg)
      rewriteFiles(siteDir, files, (text) => text.replace(link, `$1$2${op.currentSeg}`))
      assertNoneLeft(siteDir, files, link, `Links to /${op.component}/${op.fromSeg}`)
      log.push(`${op.component}/: links to ${op.fromSeg} now point to ${op.currentSeg}`)
      const s = copyStatic(siteDir, op.component, op.fromSeg, op.currentSeg, {move: true})
      if (s) log.push(`static/${op.component}/${op.currentSeg}/: ${s} files moved from static/${op.component}/${op.fromSeg}/`)
      const moving = new Set(redirectsUnder(redirects, op.component, op.fromSeg))
      redirects = redirects.map((entry) => moving.has(entry)
        ? {from: reseg(entry.from, op.component, op.fromSeg, op.currentSeg), to: reseg(entry.to, op.component, op.fromSeg, op.currentSeg)}
        : entry)
      touched.add(REDIRECTS)
      log.push(`${REDIRECTS}: ${moving.size} page aliases moved to ${op.component} ${op.currentSeg}`)
      current[op.component] = {...current[op.component], currentSeg: op.currentSeg, currentLabel: op.currentLabel}
      touched.add(CURRENT_VERSIONS)
      log.push(`${CURRENT_VERSIONS}: ${op.component} current is ${op.currentSeg} (${op.currentLabel})`)
    } else if (op.op === 'setLatestRedirects') {
      netlify = setLatestRedirects(netlify, op.component, op.latest, op.latestDev)
      touched.add(NETLIFY_REDIRECTS)
      log.push(`${NETLIFY_REDIRECTS}: /${op.component}/latest -> ${op.latest}, latest-dev -> ${op.latestDev}`)
    } else {
      throw new Error(`Unknown op ${op.op}`)
    }
  }

  if (touched.has(VARIABLES)) write(siteDir, VARIABLES, variablesFile.serialize(variables))
  if (touched.has(REDIRECTS)) write(siteDir, REDIRECTS, redirectsFile.serialize(redirects))
  if (touched.has(CURRENT_VERSIONS)) write(siteDir, CURRENT_VERSIONS, json(current))
  if (touched.has(NETLIFY_REDIRECTS)) write(siteDir, NETLIFY_REDIRECTS, netlify)
  for (const [file, list] of Object.entries(releases)) write(siteDir, file, json(list))
  return log
}

module.exports = {readState, applyOps, parseVariables, parseRedirects, versionLink}
