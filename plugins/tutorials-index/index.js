'use strict'

const fs = require('node:fs')
const path = require('node:path')

const yaml = require('js-yaml')
const { Globby } = require('@docusaurus/utils')

// Card data for the tutorials landing page (src/pages/tutorials.tsx), read from `tutorial_*`
// frontmatter and passed to the page as global data.
// Values are passed through raw; splitting comma-lists is presentation, normalising would be a content change.

const TUTORIALS_DIR = 'tutorials'

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)

function readCard(file, siteDir) {
  const raw = fs.readFileSync(file, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!m) return null
  let fm
  try {
    fm = yaml.load(m[1]) || {}
  } catch {
    return null
  }
  // A page is a card only if it carries tutorial metadata.
  if (!fm.tutorial_product && !fm.tutorial_categories && !fm.tutorial_time) return null
  return {
    title: fm.title || path.basename(file, '.mdx'),
    description: fm.description || '',
    href: `/${TUTORIALS_DIR}${fm.slug || '/' + path.basename(file, '.mdx')}`,
    time: fm.tutorial_time || '',
    product: fm.tutorial_product || '',
    languages: list(fm.tutorial_lang),
    categories: list(fm.tutorial_categories),
    enterprise: fm.tutorial_enterprise === true,
    source: fm.tutorial_source || '',
  }
}

module.exports = function tutorialsIndexPlugin(context) {
  const siteDir = context.siteDir
  return {
    name: 'tutorials-index',

    async loadContent() {
      const files = await Globby(['*.mdx'], { cwd: path.join(siteDir, TUTORIALS_DIR), absolute: true })
      const cards = files
        .map((f) => readCard(f, siteDir))
        .filter(Boolean)
        .sort((a, b) => a.title.localeCompare(b.title))
      return cards
    },

    async contentLoaded({ content, actions }) {
      actions.setGlobalData({ cards: content || [] })
    },
  }
}
