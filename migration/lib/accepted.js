'use strict'

// Accepted findings: the shared mechanism for "we have looked at this, it is
// understood, and it is not going to change" -- so a gate can be GREEN while the
// discrepancy is still reported every run.
//
// Without this, a permanent finding degrades into exactly the noise these gates
// exist to avoid: after the third run the reader learns to skim past the failure
// section, and a genuine new finding lands in a block of text nobody reads. The
// deleted `auditStillBaked` warning is the cautionary example.
//
// What keeps an accept-list honest, rather than a way to make a gate lie:
//
//   OCCURRENCE-EXACT KEYS. A key pins the finding's numbers, not just its page
//   and attribute -- accepting "12 expected, 11 found" does NOT accept "12
//   expected, 10 found". A second defect on an already-accepted page changes the
//   key and fails the gate.
//   DENY BY DEFAULT. Only an exact key match clears. Nothing is accepted by
//   pattern, prefix, or wildcard.
//   A REASON IS REQUIRED. Each entry carries a `disposition` from a closed
//   vocabulary plus a non-empty `note`. A malformed entry fails the gate.
//   STALE ENTRIES FAIL. If an accepted finding stops occurring, the file now
//   claims a defect that does not exist. Pruning it is a one-line edit, and
//   failing is what makes sure it happens -- an accept-list nobody prunes is a
//   record of what used to be true. (Deliberately stricter than orphancheck's
//   allowlist, which only warns.) Scope-aware: a `--component cloud` run only
//   judges staleness for entries in that scope.
//   NOT EVERYTHING IS ACCEPTABLE. Each gate decides which finding CLASSES may be
//   accepted. A known conversion gap, yes. "The oracle is broken" or "this
//   position has no policy", no -- those mean the gate cannot make a judgement at
//   all, and silencing them silences everything behind them.

const fs = require('node:fs')

// Why a finding is accepted. Closed set: a disposition outside it fails the gate.
const DISPOSITIONS = new Set([
  'wont-fix',      // a real gap we have decided to live with
  'upstream',      // caused by the source, fixable only in the docs repo
  'harness-limit', // the comparator cannot see the truth here (the content IS right)
  'deferred',      // will be fixed, tracked elsewhere; the note must say where
])

// Read an accept-list file. Missing file = nothing accepted (the gate is fully
// strict), which is the correct default for a fresh checkout.
function loadAccepted (file) {
  if (!fs.existsSync(file)) return { accept: {}, errors: [] }
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { accept: {}, errors: [`${file}: not valid JSON (${err.message})`] }
  }
  const accept = (doc && doc.accept) || {}
  return { accept, errors: validate(accept) }
}

// A malformed accept-list must fail: a missing reason turns the file into an
// unexplained mute button, and an unknown disposition means the vocabulary drifted.
function validate (accept) {
  const errors = []
  for (const [key, entry] of Object.entries(accept || {})) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${key}: entry must be an object with a disposition and a note`)
      continue
    }
    if (!DISPOSITIONS.has(entry.disposition)) {
      errors.push(`${key}: disposition must be one of ${[...DISPOSITIONS].join(', ')} (got ${JSON.stringify(entry.disposition)})`)
    }
    if (!(typeof entry.note === 'string' && entry.note.trim())) {
      errors.push(`${key}: a non-empty "note" is required -- say why this is understood and why it stays`)
    }
  }
  return errors
}

// Split findings into blocking and accepted, and report entries that matched
// nothing. `keyOf(finding)` must be occurrence-exact. `inScope(key, entry)` marks
// which entries this run is allowed to judge staleness for -- a scoped run must
// not call another component's entries stale (default: judge everything).
function applyAccepted (findings, accept, keyOf, inScope = () => true) {
  const accepted = []
  const blocking = []
  const matched = new Set()
  for (const f of findings) {
    const key = keyOf(f)
    const entry = Object.prototype.hasOwnProperty.call(accept, key) ? accept[key] : null
    if (entry) { matched.add(key); accepted.push({ key, entry, finding: f }) } else blocking.push(f)
  }
  const stale = Object.keys(accept || {})
    .filter((k) => !matched.has(k) && inScope(k, accept[k]))
    .sort()
  return { blocking, accepted, stale }
}

module.exports = { DISPOSITIONS, loadAccepted, validate, applyAccepted }
