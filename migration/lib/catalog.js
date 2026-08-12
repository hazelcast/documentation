'use strict'

// Shared Antora aggregate+classify step. index-pass.js (manifest emitter) and
// orphancheck/run.js (orphan gate) both need a classified ContentCatalog built
// from the SAME playbook the same way; single-sourcing it here keeps them from
// drifting (e.g. one silencing the logger or resolving the AsciiDoc config
// differently would change which pages/xrefs exist and split their views of the
// corpus). Read-only: aggregate + classify only, no document conversion.

const path = require('node:path')

const buildPlaybook = require('@antora/playbook-builder')
const aggregateContent = require('@antora/content-aggregator')
const classifyContent = require('@antora/content-classifier')
const { resolveAsciiDocConfig } = require('@antora/asciidoc-loader')
const { configureLogger } = require('@antora/logger')

// Build a classified catalog from a playbook file. `silent` drops Antora's log
// to errors-only (the gate wants a quiet run; the manifest pass wants the
// aggregation warnings). Returns the pieces both callers need without deciding
// what to do with them.
async function buildContentCatalog (playbookFile, { silent = false } = {}) {
  const playbook = buildPlaybook(['--playbook', path.resolve(playbookFile)], {})
  configureLogger(silent ? { ...playbook.runtime.log, level: 'silent' } : playbook.runtime.log)
  const asciidocConfig = resolveAsciiDocConfig(playbook)
  const aggregate = await aggregateContent(playbook)
  const contentCatalog = classifyContent(playbook, aggregate, asciidocConfig)
  return { playbook, asciidocConfig, aggregate, contentCatalog }
}

module.exports = { buildContentCatalog }
