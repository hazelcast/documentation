'use strict'

const fs = require('node:fs')
const path = require('node:path')

const yaml = require('js-yaml')
const { Globby } = require('@docusaurus/utils')

// Card data for the tutorials landing page (src/pages/tutorials.tsx).
//
// Antora's landing page reads the content catalog at render time and keeps every
// page whose header says `page-layout: tutorial`, pulling the card's title, blurb,
// time, product, languages and categories straight off that page's attributes.
// There is no catalog here, so the converter carries those attributes onto each
// tutorial as `tutorial_*` frontmatter and this plugin reads them back, handing
// the page one array through global data.
//
// Values are passed through RAW. `tutorial_categories` and `tutorial_lang` are
// comma-lists whose casing and vocabulary are inconsistent across the 57 guides
// ("Get Started" vs "Getting Started", `python3`, `cplus`); splitting is presentation,
// but normalising would be a content change and belongs to the post-cutover
// taxonomy work, not here.

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
  // The gate is the same one production applies: a page is a card only if it
  // carries the tutorial metadata, which the converter writes only for pages
  // whose source declared `page-layout: tutorial`.
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
