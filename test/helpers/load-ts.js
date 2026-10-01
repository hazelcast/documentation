'use strict'

// Loads the site's TypeScript/TSX modules in plain Node the way the build resolves them: `@site/` aliases,
// extensionless imports, and the Docusaurus client hooks and Link replaced by stubs a test drives through `client`.

const path = require('node:path')
const babel = require('@babel/core')

const site = path.resolve(__dirname, '../..')

const client = (globalThis.__hzTestClient ??= {pathname: '/', active: undefined})

const transform = ({source, filename}) => ({
  code: babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      [require.resolve('@babel/preset-typescript'), {isTSX: true, allExtensions: true}],
      [require.resolve('@babel/preset-react'), {runtime: 'automatic'}],
    ],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  }).code,
})

const jiti = require('jiti')(path.join(site, 'package.json'), {
  interopDefault: true,
  cache: false,
  extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
  transform,
  alias: {
    '@site': site,
    '@docusaurus/router': path.join(__dirname, 'router.js'),
    '@docusaurus/Link': path.join(__dirname, 'link.js'),
    '@docusaurus/plugin-content-docs/client': path.join(__dirname, 'docs-client.js'),
  },
})

const loadTs = (rel) => jiti(path.join(site, rel))

module.exports = {site, client, loadTs}
