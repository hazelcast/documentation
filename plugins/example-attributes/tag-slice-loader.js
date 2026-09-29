'use strict'

// Build-time webpack loader: slices an example file to the region requested in the import query:
//   ?tag=name (&indent=0), or ?lines=36..47
// Runs first in the examples rule. With no query the file passes through (BOM stripped).
// The file on disk stays complete and compilable; slicing at build is what lets the page show only the region.

const { sliceRegion, stripBom } = require('../lib/slice-region')

module.exports = function tagSliceLoader (source) {
  const q = new URLSearchParams(this.resourceQuery || '')
  const tag = q.get('tag') || q.get('tags')
  const lines = q.get('lines')
  const indent = q.get('indent')
  // BOM is dropped even on the whole-file path (Asciidoctor did too); stripBom is shared with the slicer.
  if (tag == null && lines == null && indent == null) return stripBom(source)

  const selector = {}
  if (tag != null) selector.tag = tag
  if (lines != null) selector.lines = lines
  if (indent != null) selector.indent = indent
  // sliceRegion throws on an absent or unterminated tag; let it, so a stale region fails the build.
  return sliceRegion(source, selector, this.resourcePath)
}
