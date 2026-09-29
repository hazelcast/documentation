'use strict'

// Applies planBump's steps to a checkout. A file that does not round-trip byte for byte is refused, never reformatted.

const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {withCurrent} = require('./rules')

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

// What applySteps has changed, so a failed update can put the checkout back as it was.
let journal = null

function remember (abs) {
  if (!journal || journal.originals.has(abs) || journal.created.has(abs)) return
  if (fs.existsSync(abs)) journal.originals.set(abs, fs.readFileSync(abs))
  else journal.created.add(abs)
}

function write (siteDir, file, text) {
  remember(path.join(siteDir, file))
  fs.writeFileSync(path.join(siteDir, file), text)
}

function copyFile (from, to) {
  remember(to)
  fs.mkdirSync(path.dirname(to), {recursive: true})
  fs.copyFileSync(from, to)
}

function pruneEmpty (dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name))
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
}

function undo ({originals, created}) {
  for (const abs of created) fs.rmSync(abs, {force: true})
  for (const [abs, content] of originals) {
    fs.mkdirSync(path.dirname(abs), {recursive: true})
    fs.writeFileSync(abs, content)
  }
  for (const dir of new Set([...created].map(path.dirname))) {
    for (let d = dir; fs.existsSync(d) && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d)
  }
}

function refuseUnlessRoundTrips (file, original, rebuilt) {
  if (original !== rebuilt) {
    throw new Error(`${file} is not in the format the version update writes; refusing to rewrite it`)
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
  const {entries: redirects} = parseRedirects(read(siteDir, REDIRECTS))
  return {current, releases, variables, redirects}
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

// Imports into the copy itself; others (e.g. examples staged at build time) are not the copy's to check.
function assertImportsResolve (siteDir, files, dest) {
  const missing = []
  for (const file of files.filter((f) => REWRITTEN_FILE.test(f))) {
    for (const [, target] of read(siteDir, file).matchAll(/from ['"]@site\/([^'"?]+)(?:\?[^'"]*)?['"]/g)) {
      if (!target.startsWith(`${dest}/`)) continue
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
    copyFile(path.join(siteDir, file), path.join(siteDir, target))
    copied.push(target)
  }
  if (!copied.length) throw new Error(`No tracked files under ${component}/`)
  const ownImports = new RegExp(`@site/${component}/`, 'g')
  const link = versionLink(component, fromSeg)
  const relink = fromSeg !== version
  rewriteFiles(siteDir, copied, (text) => {
    const imports = text.replace(ownImports, `@site/${dest}/`)
    return relink ? imports.replace(link, `$1$2${version}`) : imports
  })
  assertNoneLeft(siteDir, copied, ownImports, `Imports of @site/${component}/`)
  if (relink) assertNoneLeft(siteDir, copied, link, `Links to /${component}/${fromSeg}`)
  assertImportsResolve(siteDir, copied, dest)
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
    copyFile(path.join(siteDir, file), target)
  }
  if (move) {
    for (const file of files) {
      remember(path.join(siteDir, file))
      fs.rmSync(path.join(siteDir, file))
    }
    pruneEmpty(path.join(siteDir, from))
  }
  return files.length
}

function underSeg (url, component, seg) {
  const base = `/${component}/${seg}`
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}#`)
}

function reseg (url, component, fromSeg, toSeg) {
  return `/${component}/${toSeg}` + url.slice(`/${component}/${fromSeg}`.length)
}

// Page aliases within a segment. One crossing into or out of a segment that is going away stops the update.
function redirectsUnder (entries, component, seg, {removing = false} = {}) {
  const inside = (url) => underSeg(url, component, seg)
  const mixed = entries.filter(({from, to}) => inside(from) !== inside(to))
  if (removing && mixed.length) {
    throw new Error(`${REDIRECTS}: redirects crossing /${component}/${seg}: ${mixed.map((e) => `${e.from} -> ${e.to}`).join(', ')}`)
  }
  return entries.filter(({from, to}) => inside(from) && inside(to))
}

function setLatestRedirects (text, component, latest, latestDev) {
  const lines = text.split('\n')
  const replace = (prefix, target) => {
    const i = lines.findIndex((line) => line.startsWith(`${prefix} `))
    if (i === -1) throw new Error(`${NETLIFY_REDIRECTS}: no '${prefix}' rule`)
    lines[i] = lines[i].replace(new RegExp(`(\\s+/${component}/)[^/]+`), `$1${target}`)
  }
  replace(`/${component}/latest/*`, latest)
  if (latestDev) replace(`/${component}/latest-dev/*`, latestDev)
  return lines.join('\n')
}

// Rules standing in for a version before it existed, e.g. `/clc/5.5.2/*  /clc/5.5.0/:splat  307!`, would hide it.
function dropPlaceholders (text, component, segs) {
  const lines = text.split('\n')
  const dropped = lines.filter((line) => segs.some((seg) => line.startsWith(`/${component}/${seg}/* `) || line.startsWith(`/${component}/${seg} `)))
  return {text: lines.filter((line) => !dropped.includes(line)).join('\n'), dropped}
}

// A page is found by its frontmatter slug, which is what preserves its URL.
function pageExists (siteDir, component, version, url) {
  const dir = version === 'current' ? component : versionDir(component, version)
  const prefix = `/${component}/${version === 'current' ? JSON.parse(read(siteDir, CURRENT_VERSIONS))[component].currentSeg : version}`
  if (!url.startsWith(`${prefix}/`)) return false
  const slug = new RegExp(`^slug: ${url.slice(prefix.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
  const files = fs.readdirSync(path.join(siteDir, dir), {recursive: true}).map((file) => path.join(dir, file))
  return files.some((file) => REWRITTEN_FILE.test(file) && slug.test(read(siteDir, file).split('\n---')[0]))
}

function applySteps (siteDir, steps) {
  journal = {originals: new Map(), created: new Set()}
  try {
    return applyAll(siteDir, steps)
  } catch (error) {
    undo(journal)
    throw error
  } finally {
    journal = null
  }
}

function applyAll (siteDir, steps) {
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

  for (const step of steps) {
    if (step.step === 'setVars') {
      Object.assign(variables[step.component][step.version], step.values)
      touched.add(VARIABLES)
      log.push(`${VARIABLES}: ${step.component} ${step.version}: ${Object.entries(step.values).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    } else if (step.step === 'addRelease') {
      const n = copyCurrent(siteDir, step.component, step.version, step.fromSeg)
      log.push(`${versionDir(step.component, step.version)}/: ${n} files copied from ${step.component}/`)
      // Freezing main under its own segment (clc): static files and aliases stay put; setCurrent copies them on.
      const sameSeg = step.version === step.fromSeg
      const s = sameSeg ? 0 : copyStatic(siteDir, step.component, step.fromSeg, step.version)
      if (s) log.push(`static/${step.component}/${step.version}/: ${s} files copied from static/${step.component}/${step.fromSeg}/`)
      const file = releasesFile(step.component)
      releases[file] = [step.version, ...(releases[file] ?? JSON.parse(read(siteDir, file)))]
      log.push(`${file}: added ${step.version}`)
      const {current: currentVars, ...rest} = variables[step.component]
      variables[step.component] = {current: currentVars, [step.version]: {...step.variables}, ...rest}
      touched.add(VARIABLES)
      log.push(`${VARIABLES}: ${step.component} ${step.version} added`)
      if (!sameSeg) {
        const cloned = redirectsUnder(redirects, step.component, step.fromSeg).map(({from, to}) => ({
          from: reseg(from, step.component, step.fromSeg, step.version),
          to: reseg(to, step.component, step.fromSeg, step.version),
        }))
        redirects = [...redirects, ...cloned]
        touched.add(REDIRECTS)
        log.push(`${REDIRECTS}: ${cloned.length} page aliases copied to ${step.component} ${step.version}`)
      }
    } else if (step.step === 'setCurrent') {
      const files = trackedFiles(siteDir, step.component)
      const link = versionLink(step.component, step.fromSeg)
      rewriteFiles(siteDir, files, (text) => text.replace(link, `$1$2${step.currentSeg}`))
      assertNoneLeft(siteDir, files, link, `Links to /${step.component}/${step.fromSeg}`)
      log.push(`${step.component}/: links to ${step.fromSeg} now point to ${step.currentSeg}`)
      const verb = step.keepOld ? 'copied' : 'moved'
      const s = copyStatic(siteDir, step.component, step.fromSeg, step.currentSeg, {move: !step.keepOld})
      if (s) log.push(`static/${step.component}/${step.currentSeg}/: ${s} files ${verb} from static/${step.component}/${step.fromSeg}/`)
      const under = redirectsUnder(redirects, step.component, step.fromSeg, {removing: !step.keepOld})
      const resegged = (entry) => ({from: reseg(entry.from, step.component, step.fromSeg, step.currentSeg), to: reseg(entry.to, step.component, step.fromSeg, step.currentSeg)})
      redirects = step.keepOld
        ? [...redirects, ...under.map(resegged)]
        : redirects.map((entry) => (under.includes(entry) ? resegged(entry) : entry))
      touched.add(REDIRECTS)
      log.push(`${REDIRECTS}: ${under.length} page aliases ${verb} to ${step.component} ${step.currentSeg}`)
      current[step.component] = withCurrent(current[step.component], step)
      touched.add(CURRENT_VERSIONS)
      log.push(`${CURRENT_VERSIONS}: ${step.component} current is ${step.currentSeg}${step.currentLabel ? ` (${step.currentLabel})` : ''}`)
    } else if (step.step === 'setLatestRedirects') {
      netlify = setLatestRedirects(netlify, step.component, step.latest, step.latestDev)
      touched.add(NETLIFY_REDIRECTS)
      log.push(`${NETLIFY_REDIRECTS}: /${step.component}/latest -> ${step.latest}${step.latestDev ? `, latest-dev -> ${step.latestDev}` : ''}`)
    } else if (step.step === 'dropPlaceholders') {
      const result = dropPlaceholders(netlify, step.component, step.segs)
      netlify = result.text
      if (result.dropped.length) {
        touched.add(NETLIFY_REDIRECTS)
        for (const line of result.dropped) log.push(`${NETLIFY_REDIRECTS}: removed placeholder rule '${line.replace(/\s+/g, ' ')}'`)
      }
    } else if (step.step === 'addAlias') {
      if (!pageExists(siteDir, step.component, step.version, step.to)) throw new Error(`${step.from}: no page at ${step.to} to redirect to`)
      redirects = [...redirects, {from: step.from, to: step.to}]
      touched.add(REDIRECTS)
      log.push(`${REDIRECTS}: ${step.from} -> ${step.to}`)
    } else {
      throw new Error(`Unknown step ${step.step}`)
    }
  }

  if (touched.has(VARIABLES)) write(siteDir, VARIABLES, variablesFile.serialize(variables))
  if (touched.has(REDIRECTS)) write(siteDir, REDIRECTS, redirectsFile.serialize(redirects))
  if (touched.has(CURRENT_VERSIONS)) write(siteDir, CURRENT_VERSIONS, json(current))
  if (touched.has(NETLIFY_REDIRECTS)) write(siteDir, NETLIFY_REDIRECTS, netlify)
  for (const [file, list] of Object.entries(releases)) write(siteDir, file, json(list))
  return log
}

module.exports = {readState, applySteps, parseVariables, parseRedirects, versionLink}
