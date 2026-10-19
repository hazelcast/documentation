'use strict'

// Unit self-test for the sidebar gate's pure logic. The Antora inputs are the
// shape @antora/navigation-builder produces (menus of { content, url, items }),
// and the expectations come from what a reader sees in each sidebar, not from
// the converter's code. Run: node sidebarcheck/selftest.js

const assert = require('node:assert')
const { normUrl, antoraLines, docusaurusLines, diffLines, splitInjected } = require('./lib/compare')

let n = 0
const ok = (label) => { n++; console.log(`  ✓ ${label}`) }

// --- URLs: Antora's published form and Docusaurus's are the same page ---------
{
  assert.strictEqual(normUrl('/c/5.3/a/'), '/c/5.3/a', 'trailing slash')
  assert.strictEqual(normUrl('/c/5.3/a.html'), '/c/5.3/a', '.html extension')
  assert.strictEqual(normUrl('/c/5.3/a.html#x'), '/c/5.3/a#x', 'a fragment is kept')
  ok('normUrl: trailing slash and .html are not differences; a fragment is')
}

// --- Antora side: the reader-visible tree, in Docusaurus's shape -------------
{
  const { lines } = antoraLines([{
    content: 'Get started',
    items: [
      { content: 'Install', url: '/c/install/' },
      { content: 'Configure', url: '/c/configure/', items: [{ content: 'Advanced', url: '/c/advanced/' }] },
      { content: 'Data', items: [{ content: '<code>IMap</code> &amp; more', url: '/c/map/' }] },
      { content: 'What’s new', url: '/c/new/' },
    ],
  }])
  assert.deepStrictEqual(lines, [
    'Get started',
    'Get started › Install  → /c/install',
    'Get started › Configure',
    'Get started › Configure › Overview  → /c/configure',
    'Get started › Configure › Advanced  → /c/advanced',
    'Get started › Data',
    'Get started › Data › IMap & more  → /c/map',
    "Get started › What's new  → /c/new",
  ])
  ok('antoraLines: titles and groupings are categories; a parent page is its category\'s Overview; labels are visible text')

  const collapsed = antoraLines([{ content: 'Accounts', items: [{ content: 'Accounts overview', url: '/c/acc/', items: [{ content: 'Users', url: '/c/users/' }] }] }])
  assert.deepStrictEqual(collapsed.lines, ['Accounts', 'Accounts › Overview  → /c/acc', 'Accounts › Users  → /c/users'],
    'a title wrapping one parent page is one level, not two')
  ok('antoraLines: a title whose only child is a parent page collapses into it')

  const dup = antoraLines([
    { content: 'A', items: [{ content: 'Shared', url: '/c/s/', items: [{ content: 'Child', url: '/c/child/' }] }, { content: 'Other', url: '/c/o/' }] },
    { content: 'B', items: [{ content: 'Shared again', url: '/c/s/' }, { content: 'Anchor', url: '/c/o/#part' }] },
  ])
  assert(!dup.lines.some((l) => l.startsWith('B')), 'a category holding only repeats disappears')
  assert.deepStrictEqual(dup.duplicates, ['B › Shared again  → /c/s', 'B › Anchor  → /c/o#part'],
    'every dropped repeat is reported, including a link to an anchor of a listed page')
  ok('antoraLines: a page listed twice keeps its first place, and the drop is reported')

  const redirected = antoraLines([{ content: 'Get started', items: [{ content: 'What is it', url: '/c/what-is/' }] }],
    (u) => (u === '/c/what-is' ? '/c' : null))
  assert.deepStrictEqual(redirected.lines, ['Get started', 'Get started › What is it  → /c'],
    'a withheld page\'s entry keeps its place and label and points at the redirect target')
  ok('antoraLines: a redirected page\'s nav entry points at its target')

  const other = antoraLines([{ content: 'Deploy', items: [{ content: 'K8s', url: '/c/k8s/' }, { content: 'Operator', url: '/operator/5.20/get-started/' }] }],
    () => null, (u) => u.startsWith('/c/'))
  assert.deepStrictEqual(other.lines, ['Deploy', 'Deploy › K8s  → /c/k8s'])
  assert.deepStrictEqual(other.otherProduct, ['Deploy › Operator  → /operator/5.20/get-started'], 'the drop is reported')
  ok('antoraLines: an entry for another product\'s page is dropped and reported')
}

// --- Docusaurus side: what a production build shows --------------------------
{
  const items = [
    { type: 'category', label: 'Get started', items: [
      { type: 'link', label: 'Install', href: '/c/install', docId: 'install' },
      { type: 'link', label: 'Hidden', href: '/c/hidden', docId: 'hidden' },
    ] },
    { type: 'category', label: 'Only hidden', items: [{ type: 'link', label: 'H', href: '/c/h', unlisted: true }] },
  ]
  assert.deepStrictEqual(docusaurusLines(items, (it) => it.docId === 'hidden'),
    ['Get started', 'Get started › Install  → /c/install'],
    'unlisted docs are skipped, and so is a category left empty')
  ok('docusaurusLines: unlisted docs and emptied categories are not in the sidebar')
}

// --- Diff: any change of place, label, URL or order is a difference ----------
{
  const a = ['X', 'X › A  → /a', 'X › B  → /b']
  assert.deepStrictEqual(diffLines(a, a), { removed: [], added: [] }, 'identical')
  assert.deepStrictEqual(diffLines(a, ['X', 'X › B  → /b', 'X › A  → /a']).removed.length, 1, 'a reorder is a difference')
  assert.deepStrictEqual(diffLines(a, ['X', 'X › A  → /a', 'B  → /b']),
    { removed: ['X › B  → /b'], added: ['B  → /b'] }, 'a re-nested entry is one removed and one added line')
  assert.deepStrictEqual(diffLines(a, ['X', 'X › `A`  → /a', 'X › B  → /b']).added, ['X › `A`  → /a'], 'a label change is a difference')
  ok('diffLines: order, nesting and labels all count')
}

// --- Injected nav entries are expected extras, nothing else is --------------
{
  const { injected, rest } = splitInjected(['X › New  → /c/new', 'X › Stray  → /c/stray', 'Y'], new Set(['/c/new']))
  assert.deepStrictEqual(injected, ['X › New  → /c/new'])
  assert.deepStrictEqual(rest, ['X › Stray  → /c/stray', 'Y'], 'an extra category or an un-injected page still fails')
  ok('splitInjected: only pages the orphan allowlist injects are expected extras')
}

console.log(`\n[sidebarcheck selftest] ${n} groups passed.`)
