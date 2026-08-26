'use strict'

// Layer 2 comparison: diff a converted page's structural inventory against the
// golden inventory for the same URL, field by field. Any mismatch is a
// structural regression (e.g. an admonition that flattened to a paragraph, a
// dropped code block, a linearized table).
//
// HEADING CAVEAT: golden pages are Antora BODY fragments -- the h1 page title
// lives in chrome, so golden h1 is ~always 0. Docusaurus main content includes
// the h1 title. The Docusaurus-side extractor (extract-main) must drop that
// title h1 so h1 compares equal; until it does, h1 is compared leniently here
// (converted may have exactly one more).

function compareInventory (golden, converted) {
  const diffs = []
  const push = (field, g, c) => { if (g !== c) diffs.push({ field, golden: g, converted: c }) }

  for (let l = 1; l <= 6; l++) {
    const field = 'headings.h' + l
    const g = golden.headings['h' + l]
    const c = converted.headings['h' + l]
    if (l === 1) {
      // lenient: allow the converted page to carry one extra title h1
      if (!(c === g || c === g + 1)) diffs.push({ field, golden: g, converted: c })
    } else {
      push(field, g, c)
    }
  }
  for (const t of Object.keys(golden.admonitions)) {
    push('admonitions.' + t, golden.admonitions[t], converted.admonitions[t])
  }
  for (const field of ['codeBlocks', 'tables', 'images', 'links', 'listItems', 'tabSets', 'tabItems']) {
    push(field, golden[field], converted[field])
  }

  // WHICH images, in document order. The `images` count above cannot see a page
  // that renders the right NUMBER of wrong pictures -- and neither can any other
  // layer (L1 is text, an <img> contributes none; L3 reads only <a href>), nor
  // the site build, whose `onBrokenMarkdownImages: 'throw'` proves a path
  // resolves, never that it resolves to the intended file.
  //
  // Only reported when the counts already agree: a length difference is the
  // `images` diff above, and repeating it here as a name list would be noise.
  const gNames = golden.imageNames || []
  const cNames = converted.imageNames || []
  // A converted name of null is an image webpack inlined as a base64 data URI,
  // which carries no file name to compare -- skipped rather than reported, since
  // the alternative is a false positive on every small icon.
  if (gNames.length === cNames.length && gNames.some((n, i) => cNames[i] != null && n !== cNames[i])) {
    const at = gNames.map((n, i) => [i, n, cNames[i]]).filter(([, g, c]) => c != null && g !== c)
    diffs.push({
      field: 'imageNames',
      golden: at.map(([i, g]) => `#${i} ${g}`).join(', '),
      converted: at.map(([i, , c]) => `#${i} ${c}`).join(', '),
    })
  }
  return diffs
}

module.exports = { compareInventory }
