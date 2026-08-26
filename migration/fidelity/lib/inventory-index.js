'use strict'

// The golden structural inventory: site URL -> inventory (Layer 2 "expected"
// side). Built from all golden pages, cached to disk keyed by the lockfile so
// it is built once per baseline. The runner extracts the same inventory from
// each converted page (with the Docusaurus profile) and diffs field-by-field;
// any per-page mismatch is a structural regression flag.

const fs = require('node:fs')
const path = require('node:path')

const { goldenPages, readGolden } = require('./pairing')
const { inventory, ASCIIDOC_PROFILE, INVENTORY_VERSION } = require('./structure')

function buildInventoryIndex (goldenDir) {
  const index = new Map()
  for (const p of goldenPages(goldenDir)) {
    index.set(p.url, inventory(readGolden(p.file), ASCIIDOC_PROFILE))
  }
  return index
}

function loadInventoryIndex (goldenDir, lockfileKey, cacheFile) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      // Keyed by the source pin AND the extractor's version: the pin alone
      // cannot notice that inventory() started extracting a new field.
      if (cached.lockfileKey === lockfileKey && cached.inventoryVersion === INVENTORY_VERSION) {
        return new Map(Object.entries(cached.byPage))
      }
    } catch { /* rebuild */ }
  }
  const index = buildInventoryIndex(goldenDir)
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ lockfileKey, inventoryVersion: INVENTORY_VERSION, byPage: Object.fromEntries(index) }))
  }
  return index
}

module.exports = { buildInventoryIndex, loadInventoryIndex }
