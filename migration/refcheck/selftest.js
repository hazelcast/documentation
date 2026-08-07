'use strict'

// Unit self-test for the reference checker's pure logic -- the parts that decide
// what counts as a source reference and as a preserved reference. Guards against
// regressions in the matchers without needing a golden/output tree. Run:
//   node refcheck/selftest.js

const assert = require('node:assert')

const { refsIn, includesIn, resolveTarget, sliceByTags, stripComments } = require('./lib/source-refs')
const { hasRef, importsOf, slugOf } = require('./lib/mdx-refs')
const { isBakeSafe } = require('./lib/bake-safe')
const { wrapRefs, wrappableRefs, spanify, stripAttrSpans, hasSentinelResidue } = require('../antora-extension/mark-attributes')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- source: attribute references ----------------------------------------
{
  const names = refsIn('use {hazelcast-cloud} and {page-latest-supported-mc}, but not \\{escaped} nor {0-ok}')
  assert(names.has('hazelcast-cloud') && names.has('page-latest-supported-mc'), 'counts real refs')
  assert(!names.has('escaped'), 'escaped \\{ref} is a literal, not a reference')
  assert(names.has('0-ok'), 'digit-leading names still match (filtered later by the manifest table)')
  ok('refsIn: counts unescaped refs, ignores \\{escaped}')
}

// --- source: comments are not references ---------------------------------
{
  const stripped = stripComments('a {keep}\n// a {dropped-line}\n////\n{dropped-block}\n////\nb {keep2}')
  const names = refsIn(stripped)
  assert(names.has('keep') && names.has('keep2'), 'keeps content refs')
  assert(!names.has('dropped-line') && !names.has('dropped-block'), 'drops comment refs')
  ok('stripComments: line and block comments removed before scanning')
}

// --- source: include parsing + resolution --------------------------------
{
  const incs = includesIn('include::partial$note.adoc[]\ninclude::example$/x.yaml[tag=demo]\nnot an include')
  assert(incs.length === 2, 'finds both includes')
  assert(incs[1].tag === 'demo', 'captures tag=')
  ok('includesIn: finds include:: directives and tag=')

  const from = { component: 'operator', module: 'ROOT', family: 'page', relative: 'upgrade.adoc' }
  assert.strictEqual(resolveTarget('partial$note.adoc', from).family, 'partial', 'partial$ family')
  assert.strictEqual(resolveTarget('example$/x.yaml', from).family, 'example', 'example$ family')
  const bare = resolveTarget('sibling.adoc', from)
  assert(bare && bare.family === 'page' && bare.relative === 'sibling.adoc', 'bare relative -> page, same dir')
  assert.strictEqual(resolveTarget('imdg:ROOT:partial$x.adoc', from), null, 'no-mirror component -> null')
  assert.strictEqual(resolveTarget('image$logo.png', from), null, 'non-content family -> null')
  ok('resolveTarget: family + component defaulting + resolution-only skip')
}

// --- source: tag slicing --------------------------------------------------
{
  const doc = 'pre {ignore}\n// tag::demo[]\nkeep {inside}\n// end::demo[]\npost {ignore2}'
  const sliced = sliceByTags(doc, 'demo')
  const names = refsIn(sliced)
  assert(names.has('inside') && !names.has('ignore') && !names.has('ignore2'), 'keeps only tagged region')
  assert(refsIn(sliceByTags(doc, null)).has('ignore'), 'no tag -> whole file')
  ok('sliceByTags: honours tag= selection')
}

// --- output: preserved-reference detection -------------------------------
{
  assert(hasRef('x <Variable name="page-latest-supported-mc"/> y', 'page-latest-supported-mc'), 'prose Variable')
  assert(hasRef('<Variable href="{page-cloud-console}" text="Cloud console"/>', 'page-cloud-console'), 'link token')
  assert(hasRef('```shell vars\nhelm install {operator-chart-version}\n```', 'operator-chart-version'), 'code token')
  assert(!hasRef('the word Cloud appears but no ref', 'hazelcast-cloud'), 'baked literal is NOT a reference')
  assert(!hasRef('escaped \\{version\\} stays literal', 'version'), 'escaped token is NOT a reference')
  ok('hasRef: matches every preserved form, rejects baked/escaped literals')
}

// --- output: import parsing ----------------------------------------------
{
  const mdx = [
    "import PartialClusterData from '@site/cloud/_partials/cluster-data.mdx'",
    "import Ex_hazelcast_yaml from '../examples/hazelcast.yaml';",
    "import CodeBlock from '@theme/CodeBlock';",
  ].join('\n')
  const { partials, examples } = importsOf(mdx, '/root/cloud/manage/x.mdx', '/root')
  assert(partials.length === 1 && partials[0] === '/root/cloud/_partials/cluster-data.mdx', 'resolves @site partial')
  assert(examples.length === 1 && examples[0] === '/root/cloud/examples/hazelcast.yaml', 'resolves relative example')
  ok('importsOf: resolves partial (@site) and example (relative) imports; ignores theme imports')

  assert.strictEqual(slugOf('---\ntitle: "X"\nslug: /cloud/foo\n---\nbody'), '/cloud/foo', 'reads frontmatter slug')
  ok('slugOf: reads the URL-preserving slug')
}

// --- bake-safe allowlist --------------------------------------------------
{
  assert(isBakeSafe('source-highlighter') && !isBakeSafe('hazelcast-cloud'), 'machinery safe, content not')
  ok('bake-safe: allowlists machinery, not content attributes')
}

// --- mark-attributes: round trip + context skips ------------------------
{
  const names = ['hazelcast-cloud']
  // Direct prose: wrap -> (render resolves {name}) -> spanify -> strip == clean.
  const src = 'Use {hazelcast-cloud} here.'
  const rendered = wrapRefs(src, names).replace(/\{hazelcast-cloud\}/g, 'Cloud')
  const spanned = spanify(rendered)
  assert.strictEqual(spanned, 'Use <span class="hz-attr-hazelcast-cloud">Cloud</span> here.', 'sentinel -> span')
  assert(!hasSentinelResidue(spanned), 'no sentinel residue after spanify')
  assert.strictEqual(stripAttrSpans(spanned), 'Use Cloud here.', 'strip reproduces clean text')
  ok('mark-attributes: wrap -> spanify -> strip round trip is byte-faithful')

  // Context skips: heading and image alt NOT marked; :description: marked ONLY
  // when the body renders it via {description}.
  assert(wrappableRefs('== {hazelcast-cloud} Standard', names).has('hazelcast-cloud'), 'section heading markable (role span, id-safe)')
  assert.strictEqual(wrappableRefs('= {hazelcast-cloud} Title', names).size, 0, 'doc title (level 0) not markable -> frontmatter')
  assert.strictEqual(wrappableRefs('image::x.svg[a {hazelcast-cloud} thing]', names).size, 0, 'block image alt not markable')
  assert(wrappableRefs('Prose {hazelcast-cloud} ok.', names).has('hazelcast-cloud'), 'prose markable')
  assert.strictEqual(wrappableRefs(':description: From {hazelcast-cloud}.\n\n== T', names).size, 0, ':description: unused -> not markable')
  assert(wrappableRefs(':description: From {hazelcast-cloud}.\n\n{description}', names).has('hazelcast-cloud'), ':description: rendered via {description} -> markable')
  ok('mark-attributes: section-heading + prose + rendered :description: markable; title/image-alt/unused-:description: not')

  // A section-heading reference wraps as a ROLE SPAN (keeps the anchor id clean);
  // flow text wraps as sentinels.
  assert(wrapRefs('== {hazelcast-cloud} X', names).includes('[.hz-attr-hazelcast-cloud]#{hazelcast-cloud}#'), 'heading -> role span')
  assert(!wrapRefs('Prose {hazelcast-cloud}.', names).includes('[.hz-attr-'), 'flow -> sentinel, not role span')
  ok('mark-attributes: heading uses id-safe role span, flow uses sentinels')
}

console.log(`\n[refcheck selftest] ${n} groups passed.`)
