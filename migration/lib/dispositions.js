'use strict'

// Shared read access to the orphan triage decisions in orphancheck/allowlist.json.
//
// An orphan decision is not just a note for the gate — it is an instruction to
// the build: `drop-404` means stop publishing the page, `keep-in-nav` means put
// it in the nav it is missing from. Reading the decision from the same file the
// human wrote it in keeps the two from drifting, which is the failure mode worth
// designing against: a gate reporting a page as dropped while the converter
// happily keeps emitting it, or a nav fix that lives only in a hand-edit and is
// silently reverted by the next conversion run.
//
// Keys are the logical page keys orphancheck reports (`{component}[:{module}]/
// {relative-without-.adoc}`), so one entry covers a page across every version.

const fs = require('node:fs')
const path = require('node:path')

const { logicalKey } = require('../orphancheck/lib/reachability')

const ALLOWLIST = path.join(__dirname, '..', 'orphancheck', 'allowlist.json')

function loadDispositions (file = ALLOWLIST) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return new Map(Object.entries(raw.allow || {}))
}

// The logical key of a manifest-shaped resource ({component, module, relative}).
const keyOf = (r) => logicalKey({ component: r.component, module: r.module, relative: r.relative })

// Pages the migration deliberately does not publish: a `drop-404` orphan is dead
// or empty and its URL is allowed to 404. Returned as a predicate so callers
// (converter, gates) all ask the same question the same way — the converter to
// skip emitting, the gates to keep the page out of scope entirely rather than
// counting it as "not yet converted" (which would quietly overstate the work
// still to do).
function isDropped (dispositions, resource) {
  const e = dispositions.get(keyOf(resource))
  return !!(e && e.disposition === 'drop-404')
}

// The published URLs of every dropped page, for gates that see pages by URL
// rather than by manifest record (fidelity pairs golden HTML files to converted
// output). Same decision as isDropped, keyed the way those callers can use it.
function droppedUrls (dispositions, manifest) {
  const urls = new Set()
  for (const r of (manifest.resources || [])) {
    if (r.family === 'page' && r.url && isDropped(dispositions, r)) urls.add(r.url)
  }
  return urls
}

// Nav entries the migration ADDS for a component: a `keep-in-nav` orphan whose
// entry carries a `nav.after` placement (the stem of the sibling it follows).
// The source nav.adoc is left untouched; the injection happens in-memory during
// conversion, so the fix is reproducible on every run and reviewable as data.
// Returns [{ stem, after }].
function navInjectionsFor (dispositions, component) {
  const out = []
  for (const [key, entry] of dispositions) {
    if (!entry || entry.disposition !== 'keep-in-nav' || !entry.nav) continue
    const [comp, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (comp !== component) continue
    out.push({ stem: rest.split('/').pop(), after: entry.nav.after })
  }
  return out
}

module.exports = { loadDispositions, keyOf, isDropped, droppedUrls, navInjectionsFor, ALLOWLIST }
