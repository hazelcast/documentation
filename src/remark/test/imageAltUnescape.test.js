'use strict'

// Spec: the rendered alt (and title) of a Markdown image is exactly the Markdown alt, whatever characters it holds.
// Tested against the real pipeline: Docusaurus's transformImage produces the <img> node, the plugin runs after it
// as in the build, and React renders the attribute.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cheerio = require('cheerio')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const escapeHtml = require('escape-html')
const transformImage = require('@docusaurus/mdx-loader/lib/remark/transformImage').default
const {loadTs} = require('../../../test/helpers/load-ts')

const {default: imageAltUnescape, unescapeHtml} = loadTs('src/remark/imageAltUnescape.ts')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-unescape-'))
test.after(() => fs.rmSync(dir, {recursive: true}))
fs.writeFileSync(path.join(dir, 'x.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
const vfile = {path: path.join(dir, 'page.mdx'), data: {compilerName: 'client'}}

async function renderedImage (alt, {withPlugin = true, title} = {}) {
  const img = {type: 'image', url: './x.png', alt, title}
  const tree = {type: 'root', children: [{type: 'paragraph', children: [img]}]}
  await transformImage({siteDir: dir, staticDirs: [], onBrokenMarkdownImages: 'throw'})(tree, vfile)
  if (withPlugin) imageAltUnescape()(tree)
  const node = tree.children[0].children[0]
  const props = Object.fromEntries(node.attributes
    .filter((a) => a.name === 'alt' || a.name === 'title').map((a) => [a.name, a.value]))
  const $ = cheerio.load(renderToStaticMarkup(React.createElement('img', props)))
  return {alt: $('img').attr('alt'), title: $('img').attr('title')}
}

const ALTS = [
  "Platform console displays the cluster name 'hello-world'",
  'Migrating 3.12 <→ 5.x',
  'a "quoted" & literal &amp; &lt;entity&gt; text',
  'plain alt',
]

test('without the plugin, transformImage alone double-escapes the alt (the problem is real)', async () => {
  assert.notEqual((await renderedImage(ALTS[0], {withPlugin: false})).alt, ALTS[0])
})

test('with the plugin, the rendered alt equals the Markdown alt for every special character', async () => {
  for (const alt of ALTS) assert.equal((await renderedImage(alt)).alt, alt)
})

test('the image title gets the same treatment', async () => {
  assert.equal((await renderedImage('x', {title: "it's <here>"})).title, "it's <here>")
})

test('unescapeHtml inverts exactly one escape-html pass, so entity-like text survives as text', () => {
  for (const s of ['&amp;lt;', '&&#39;', 'no entities']) assert.equal(unescapeHtml(escapeHtml(s)), s)
})

test('a hand-written JSX <img> (string src, not transformImage output) is left alone', () => {
  const jsx = {
    type: 'mdxJsxTextElement',
    name: 'img',
    attributes: [{type: 'mdxJsxAttribute', name: 'src', value: '/x.png'}, {type: 'mdxJsxAttribute', name: 'alt', value: '&amp;'}],
  }
  imageAltUnescape()({type: 'root', children: [jsx]})
  assert.equal(jsx.attributes[1].value, '&amp;')
})
