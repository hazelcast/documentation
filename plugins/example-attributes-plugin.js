'use strict'

const path = require('node:path')

// Attaches the example-attributes loader (see example-attributes-loader.js) to
// co-located example files via a scoped webpack module rule, so the converter
// can import them plainly:
//
//   import Ex from '../examples/foo.yaml';
//
// The rule chains our loader before raw-loader: our loader substitutes {attr}
// placeholders in the raw text, then raw-loader turns the result into a string
// module. The doc-variable values are read once from src/variables.ts (the
// single source) by docusaurus.config and passed here as `options`, then handed
// to the loader — the loader reads no file of its own.
//
// Scoped to files under an `examples/` dir of a docs component so it never
// touches unrelated YAML/XML elsewhere in the build.
const EXAMPLES_RE = /[\\/]examples[\\/].+\.(ya?ml|xml|java|properties|txt|sh|json|conf|cfg)$/

module.exports = function exampleAttributesPlugin (context, options) {
  const { variables = {}, versionedVariables = {} } = options || {}
  return {
    name: 'example-attributes',
    configureWebpack () {
      return {
        module: {
          rules: [
            {
              test: EXAMPLES_RE,
              // Applied right-to-left: slice the region out of the file, then
              // substitute {attribute} placeholders in the slice, then let
              // raw-loader turn the result into a string module.
              use: [
                'raw-loader',
                {
                  loader: path.resolve(__dirname, 'example-attributes-loader.js'),
                  options: { variables, versionedVariables },
                },
                path.resolve(__dirname, 'tag-slice-loader.js'),
              ],
            },
          ],
        },
      }
    },
  }
}
