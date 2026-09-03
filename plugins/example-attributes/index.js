'use strict'

const path = require('node:path')

// Attaches the example-attributes loader (see attributes-loader.js) to
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
// `.tutorial-examples/` is matched too: the tutorials' staged files are client
// programs in six languages, and an unmatched `.js`/`.py` import would be parsed
// as a MODULE rather than read as text (webpack then tries to resolve the
// example's own `require('hazelcast-client')` and fails the build).
const EXAMPLES_RE = /[\\/](?:examples|\.tutorial-examples)[\\/].+\.(ya?ml|xml|java|properties|txt|sh|json|conf|cfg|js|py|go|cs|ps1|ini|tf)$/

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
              // Without this webpack still applies its BUILT-IN JSON parser to a
              // `.json` example after these loaders have turned it into
              // `export default "…"`, and the build dies on "JSON parse error:
              // Unexpected character e". Two of the guides' examples are .json.
              type: 'javascript/auto',
              // Applied right-to-left: slice the region out of the file, then
              // substitute {attribute} placeholders in the slice, then let
              // raw-loader turn the result into a string module.
              use: [
                'raw-loader',
                {
                  loader: path.resolve(__dirname, 'attributes-loader.js'),
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
