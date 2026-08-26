'use strict'

// Where a co-located image FILE lands inside a version tree -- the single
// source of truth for both halves of image handling: the converter emits a
// reference relative to the consuming page's own output file, and
// extract-images.js writes the bytes at the same path.
//
// WHY THIS IS NOT DERIVABLE FROM THE IMAGE'S URL. Antora publishes an image
// under its OWNING module's `_images` directory, and most references reach it
// by cross-module resource ID (`image:ROOT:Foo.png[]` -- 176 of 180 references
// in management-center, 76 of 129 in hazelcast). So the published URL records
// where the image is STORED, never who uses it, and a URL-derived layout can
// only reproduce the source's flat per-module dump. Placement therefore has to
// be computed from the REFERENCE GRAPH: which pages actually render the image.
//
// The converter owns that graph (it alone knows each page's output file, which
// follows the nav plan rather than the URL), so it computes the plan, uses it,
// and writes it to build/image-placement.json for extract-images to consume.
// One producer, one consumer, no rule to keep in lockstep -- the previous
// design mirrored the same URL-rewriting rule in two files by hand.

const path = require('node:path')

// Co-located image folder name. No `_` prefix: image files never route (only
// `.md/.mdx` do), so the routing-exclusion shortcut `_partials/` needs does not
// apply here.
const IMAGES_DIR = 'images'

// The deepest directory containing every one of `dirs` (each POSIX, relative to
// the version tree root; '' is the root itself). Segment-wise, so it can never
// return a path that is not a real ancestor of them all.
function commonAncestorDir (dirs) {
  const split = [...dirs].map((d) => (d ? d.split('/') : []))
  if (split.length === 0) return ''
  const out = []
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i]
    if (!split.every((p) => p[i] === seg)) break
    out.push(seg)
  }
  return out.join('/')
}

// The part of an image URL BELOW its `_images` directory, which is what gets
// re-rooted under the destination `images/` folder. Usually a bare filename,
// but Antora allows subdirectories (hazelcast's `wan/_images/wan/*.png`) and
// flattening those to a basename would both lose the authored grouping and
// invite collisions. Falls back to the basename for a URL with no `_images`
// segment at all, which no Antora image has.
function imageTail (url) {
  const m = url.match(/(?:^|\/)_images\/(.+)$/)
  return m ? m[1] : path.posix.basename(url)
}

// refs: iterable of { url, dir } -- one entry per (image, consuming file),
// where `dir` is the POSIX directory of the consuming .mdx relative to the
// version tree root ('' for a file at the root). Returns Map(url -> tree-
// relative destination path).
//
// An image referenced from a single directory (166 of MC's 170) lands in that
// directory's `images/`. One referenced from several lands in their deepest
// common ancestor's, which is the only placement a single relative reference
// from each consumer can reach without duplicating bytes. Two consumers with no
// shared ancestor fall back to the tree root, exactly as before.
function planImagePlacement (refs) {
  const consumers = new Map()
  for (const { url, dir } of refs) {
    if (!consumers.has(url)) consumers.set(url, new Set())
    consumers.get(url).add(dir || '')
  }

  const plan = new Map()
  const byDest = new Map()
  for (const url of [...consumers.keys()].sort()) {
    const dest = path.posix.join(commonAncestorDir(consumers.get(url)), IMAGES_DIR, imageTail(url))
    // Two DIFFERENT images resolving to one path would silently overwrite each
    // other in extract-images and leave one set of pages showing the wrong
    // picture -- the exact failure no fidelity layer used to be able to see.
    // There are no such collisions in any current source repo (0 duplicate
    // basenames across every module image directory in hz-docs and
    // management-center-docs), so this is a tripwire for a future one.
    if (byDest.has(dest)) {
      throw new Error(
        `[image-placement] two images would be written to ${dest}:\n` +
          `  ${byDest.get(dest)}\n  ${url}\n` +
          'Rename one in the source repo, or extend imageTail() to keep them apart.'
      )
    }
    byDest.set(dest, url)
    plan.set(url, dest)
  }
  return plan
}

module.exports = { IMAGES_DIR, commonAncestorDir, imageTail, planImagePlacement }
