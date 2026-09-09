'use strict'

// Build-time webpack loader: slices an example file down to the region a page
// asks for, from the import's query string.
//
//   import Ex from '../examples/cp/CpSubsystemAPI.java?tag=apisample';
//   import Ex from '../examples/dds/map/LoadAll.java?tag=loadall&indent=0';
//   import Ex from '../examples/distributedcomputing/FibonacciCallable.java?lines=36..47';
//
// Runs FIRST in the examples rule (before attributes-loader and
// raw-loader), so it sees the raw file text and the rest of the chain operates
// on the slice.
//
// The file on disk stays a complete, compilable .java file -- Platform's
// examples are a Maven source root, and `package`/`import` lines sit outside
// the tag markers precisely so the file compiles while the page shows only the
// region. Slicing at build is what lets both be true at once.
//
// With NO query the file passes through untouched. That is the operator
// whole-file path, and it stays byte-for-byte what it is today.

const { sliceRegion, stripBom } = require('../lib/slice-region')

module.exports = function tagSliceLoader (source) {
  const q = new URLSearchParams(this.resourceQuery || '')
  const tag = q.get('tag') || q.get('tags')
  const lines = q.get('lines')
  const indent = q.get('indent')
  // Even untouched, the BOM comes off: Asciidoctor dropped it, so a page that
  // renders one differs from what it replaced. stripBom is the slicer's, so the
  // whole-file path and the sliced path cannot disagree.
  if (tag == null && lines == null && indent == null) return stripBom(source)

  const selector = {}
  if (tag != null) selector.tag = tag
  if (lines != null) selector.lines = lines
  if (indent != null) selector.indent = indent
  // sliceRegion throws on an absent or unterminated tag. Let it: a page asking
  // for a region that no longer exists must fail the build, not ship an empty
  // code block. The resource path makes the message actionable.
  return sliceRegion(source, selector, this.resourcePath)
}
