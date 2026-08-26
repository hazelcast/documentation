'use strict'

// Tab-group syncing: which `<Tabs>` on the site share a selection.
//
// Docusaurus syncs two tabsets only when they carry the same `groupId` — the
// selected value is stored under `docusaurus.tab.<groupId>` and every mounted
// `<Tabs>` with that id re-syncs from it (same page and later pages both, since
// the storage slot dispatches a same-window change event). No `groupId` means
// every tabset is an island, which is what the first cut of the converter
// emitted: three "Linux and Mac / Windows" tabsets on one page, switched one at
// a time. So every tabset gets a `groupId`.
//
// Neither `groupId` nor a TabItem's `value` reaches the DOM (only `label` is
// rendered), so both are free to change: this is invisible to the fidelity
// harness.
//
// Two things decide the id:
//
//   1. VALUE_ALIASES normalises the tab *values*. The same axis is slugged
//      differently across repos and versions — `node-js` vs `nodejs`,
//      `cli-clc` vs `clc`, `hz-mc-conf` vs `mc-conf` — purely by accident of
//      who wrote the page. Aliasing makes those one value so they sync. Labels
//      are untouched: a tab still SAYS `hz-mc-conf` where the source said so.
//
//   2. FAMILIES names the recurring axes (os, client language, cloud provider,
//      …). A tabset joins a family when all of its normalised values belong to
//      that family's vocabulary, which makes membership survive a tabset that
//      offers a subset — `{clc,java,nodejs,go,python}` syncs with
//      `{clc,java,nodejs,go,python,net}`, and `{linux,mac,windows}` shares
//      `windows` with `{linux-and-mac,windows}`. Where the stored value is
//      absent from a group, Docusaurus falls back to that group's own default,
//      so a partial overlap degrades quietly instead of erroring.
//
// Anything not in a family gets a groupId derived from its own sorted values,
// so identical tabsets still sync without anyone having to curate them. That is
// the common case; a family is only worth declaring for an axis whose vocabulary
// varies.

const VALUE_ALIASES = new Map([
  ['node-js', 'nodejs'],
  ['cli-clc', 'clc'],
  ['hz-mc-conf', 'mc-conf'],
  // "Install Script (Linux/macOS)" opposite a "Windows" tab: the OS axis wearing
  // the installation method's name.
  ['install-script-linux-macos', 'linux-and-mac'],
])

// Declaration order is not significant — a tabset matching two families is an
// error, not a precedence question (see groupIdFor). `java` sits in two
// vocabularies because both axes genuinely offer it: a client language, and
// "configure programmatically" opposite XML/YAML.
const FAMILIES = [
  ['os', ['linux-and-mac', 'windows', 'linux', 'mac']],
  ['client-language', ['clc', 'java', 'nodejs', 'go', 'python', 'net']],
  ['config-format', ['java', 'xml', 'yaml']],
  ['cloud-provider', ['aws', 'gcp', 'azure']],
  ['object-storage', ['s3', 'gcs', 'abs']],
  ['k8s-platform', ['kubernetes', 'openshift']],
  ['product', ['hazelcast', 'management-center']],
  ['mc-config-method', ['ui', 'mc-conf']],
].map(([id, values]) => ({ id, values: new Set(values) }))

const normalizeValue = (value) => VALUE_ALIASES.get(value) || value

// Normalise a tabset's values, refusing an alias that would collide. Docusaurus
// throws on duplicate values within one `<Tabs>`, and a tabset offering both
// `mc-conf` and `hz-mc-conf` would produce exactly that. None exists today; if
// one appears, the alias needs splitting rather than silently losing the sync.
function normalizeValues (values) {
  const out = values.map(normalizeValue)
  const seen = new Set()
  out.forEach((v, i) => {
    if (seen.has(v)) {
      throw new Error(
        `tabs: normalising [${values.join(', ')}] collides on "${v}" ` +
        `(${values[i]} -> ${v}). Split the VALUE_ALIASES entry in converter/lib/tabs.js.`
      )
    }
    seen.add(v)
  })
  return out
}

// The groupId for a tabset's already-normalised values.
function groupIdFor (values) {
  const matches = FAMILIES.filter((f) => values.every((v) => f.values.has(v)))
  if (matches.length > 1) {
    throw new Error(
      `tabs: [${values.join(', ')}] matches families ${matches.map((m) => m.id).join(' and ')}. ` +
      `Disambiguate in converter/lib/tabs.js.`
    )
  }
  if (matches.length === 1) return matches[0].id
  return [...values].sort().join('--')
}

module.exports = { VALUE_ALIASES, FAMILIES, normalizeValue, normalizeValues, groupIdFor }
