'use strict'

// src/remark/imageAltUnescape.ts, tested against the real thing: Docusaurus's own
// transformImage produces the <img> node, our plugin runs after it as it does in
// the build, and React renders the attribute. The spec is that the rendered alt
// is exactly the Markdown alt, whatever characters it holds.

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cheerio = require('cheerio')

const site = path.resolve(__dirname, '../..')
const req = (m) => require(require.resolve(m, { paths: [site] }))
const transformImage = req('@docusaurus/mdx-loader/lib/remark/transformImage').default
const React = req('react')
const { renderToStaticMarkup } = req('react-dom/server')
const { default: imageAltUnescape, unescapeHtml } = require('../../src/remark/imageAltUnescape.ts')
const escapeHtml = req('escape-html')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-unescape-'))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
fs.writeFileSync(path.join(dir, 'x.png'), png)
const vfile = { path: path.join(dir, 'page.mdx'), data: { compilerName: 'client' } }

async function renderedAlt (alt, { withPlugin = true, title } = {}) {
  const img = { type: 'image', url: './x.png', alt, title }
  const tree = { type: 'root', children: [{ type: 'paragraph', children: [img] }] }
  await transformImage({ siteDir: dir, staticDirs: [], onBrokenMarkdownImages: 'throw' })(tree, vfile)
  if (withPlugin) imageAltUnescape()(tree)
  const node = tree.children[0].children[0]
  const props = Object.fromEntries(node.attributes
    .filter((a) => a.name === 'alt' || a.name === 'title').map((a) => [a.name, a.value]))
  const $ = cheerio.load(renderToStaticMarkup(React.createElement('img', props)))
  return { alt: $('img').attr('alt'), title: $('img').attr('title') }
}

async function main () {
  const cases = [
    "Platform console displays the cluster name 'hello-world'",
    'Migrating 3.12 <→ 5.x',
    'a "quoted" & literal &amp; &lt;entity&gt; text',
    'plain alt',
  ]

  // The bug this plugin exists for: without it, Docusaurus alone does NOT round-trip.
  const broken = await renderedAlt(cases[0], { withPlugin: false })
  assert.notStrictEqual(broken.alt, cases[0], 'transformImage alone double-escapes (the bug is real)')
  ok('without the plugin, the rendered alt is double-escaped')

  for (const alt of cases) {
    assert.strictEqual((await renderedAlt(alt)).alt, alt, `alt round-trips: ${alt}`)
  }
  ok('with the plugin, the rendered alt equals the Markdown alt for every special character')

  const t = await renderedAlt('x', { title: "it's <here>" })
  assert.strictEqual(t.title, "it's <here>", 'title round-trips too')
  ok('image title gets the same treatment')

  // Exactly one pass: text that is itself entity-like survives as text.
  for (const s of ['&amp;lt;', '&&#39;', 'no entities']) {
    assert.strictEqual(unescapeHtml(escapeHtml(s)), s, `unescape(escape(x)) === x for ${s}`)
  }
  ok('unescapeHtml inverts exactly one escape-html pass')

  // A hand-written JSX <img> (string src, not transformImage's require) is left alone.
  const jsx = { type: 'mdxJsxTextElement', name: 'img',
    attributes: [{ type: 'mdxJsxAttribute', name: 'src', value: '/x.png' }, { type: 'mdxJsxAttribute', name: 'alt', value: '&amp;' }] }
  imageAltUnescape()({ type: 'root', children: [jsx] })
  assert.strictEqual(jsx.attributes[1].value, '&amp;', 'non-transformImage <img> untouched')
  ok('only transformImage output is rewritten')

  fs.rmSync(dir, { recursive: true })
  console.log(`\n[image-alt-unescape selftest] ${n} groups passed.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
