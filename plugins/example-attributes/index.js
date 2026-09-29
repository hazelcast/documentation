'use strict'

const path = require('node:path')

// Attaches the example loaders to files under `examples/` (or `.tutorial-examples/`) via a scoped
// webpack rule, so MDX can import them as raw strings. Scoped so it never touches unrelated files;
// tutorial client programs (.js/.py) must match or webpack would parse them as modules.
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
              // Stops webpack's built-in JSON parser choking on the loaders' string output for .json examples.
              type: 'javascript/auto',
              // Applied right-to-left: slice, then substitute {attribute}s, then raw-loader.
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
