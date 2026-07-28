'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')

// The golden snapshot is keyed to the lockfile so a fidelity run can hard-stop
// when the pin the snapshot was built against no longer matches the current
// pin -- diffing against the wrong "before" is worse than not diffing at all.
// The key hashes ONLY the pinned sources (url + ref + resolved SHA), and
// deliberately NOT generatedAt/counts, so re-running the index pass without any
// SHA change does not invalidate an otherwise-valid snapshot.
function lockfileKey (lockfile) {
  const canon = (lockfile.sources || [])
    .map((s) => [s.url, s.refname || '', s.startPath || '', s.refhash || ''].join('\t'))
    .sort()
    .join('\n')
  return crypto.createHash('sha256').update(canon).digest('hex')
}

function lockfileKeyFromFile (file) {
  return lockfileKey(JSON.parse(fs.readFileSync(file, 'utf8')))
}

module.exports = { lockfileKey, lockfileKeyFromFile }
