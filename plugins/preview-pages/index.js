'use strict'

// In Netlify deploy previews, comments on the PR with direct links to the pages it changes. The URLs come from
// the docs plugins' loaded content, so slugs and versions resolve exactly as the site serves them. Files with no
// page of their own, such as partials and images, are left out. A failure only logs a warning.
// Netlify sets CONTEXT, REVIEW_ID (the PR number), and DEPLOY_PRIME_URL (the preview URL). The token needs
// write access to the repo's pull requests.

const DOCS_PLUGIN_NAME = 'docusaurus-plugin-content-docs'
const REPO = 'hazelcast/documentation'
const HEADING = '### Direct preview links'
const MAX_LINKS = 8

// Product names from the navbar, as plugins/llms-txt does ('hazelcast' -> 'Platform'). Tutorials has no
// navbar entry, so it falls back to its capitalized id.
function productLabel (siteConfig, id) {
  const item = (siteConfig.themeConfig?.navbar?.items ?? []).find((i) => i.type === 'docSidebar' && i.docsPluginId === id)
  return item?.label ?? id.charAt(0).toUpperCase() + id.slice(1)
}

// Each doc's source file mapped to its section, title, URL, and path within its version, e.g.
// { "management-center/deploy-manage/phone-homes.mdx": { section: "Management Center 5.13-SNAPSHOT",
//   title: "Usage analytics", url: "/management-center/5.13-snapshot/deploy-manage/phone-homes",
//   path: "deploy-manage/phone-homes" } }. Sections follow plugin order, then version order (newest first).
function pageMap (plugins, siteConfig) {
  const map = {}
  for (const plugin of plugins.filter((p) => p.name === DOCS_PLUGIN_NAME)) {
    const product = productLabel(siteConfig, plugin.options.id)
    const versions = plugin.content?.loadedVersions ?? []
    for (const version of versions) {
      // An unversioned product has one version, served at the product root. Docusaurus labels a current version
      // with no label of its own "Next", so its URL segment stands in.
      const label = version.label === 'Next' ? version.path.split('/').pop() : version.label
      const section = versions.length === 1 && version.path === `/${plugin.options.routeBasePath}` ? product : `${product} ${label}`
      for (const doc of version.docs) {
        map[doc.source.replace(/^@site\//, '')] = {
          section,
          title: doc.title,
          url: doc.permalink,
          path: doc.permalink.slice(version.path.length).replace(/^\//, ''),
        }
      }
    }
  }
  return map
}

// The comment text, or '' if no page changed: one list per product version, each capped at MAX_LINKS.
function renderComment (changedFiles, pages, previewUrl) {
  const changed = new Set(changedFiles)
  const sections = new Map()
  for (const [file, page] of Object.entries(pages)) {
    if (!changed.has(file)) continue
    const list = sections.get(page.section) ?? []
    if (!list.some((p) => p.url === page.url)) list.push(page)
    sections.set(page.section, list)
  }
  if (sections.size === 0) return ''
  const base = previewUrl.replace(/\/$/, '')
  const lines = [HEADING]
  for (const [section, list] of sections) {
    lines.push('', `**${section}**`, '')
    for (const page of list.slice(0, MAX_LINKS)) lines.push(`- [${page.title}](${base}${page.url})${page.path ? ` \`${page.path}\`` : ''}`)
    if (list.length > MAX_LINKS) lines.push(`- ...and ${list.length - MAX_LINKS} more`)
  }
  return lines.join('\n') + '\n'
}

async function github (token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: body && JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}`)
  return res.status === 204 ? null : res.json()
}

// Every item of a paginated GitHub list.
async function githubList (token, path) {
  const items = []
  for (let page = 1; ; page++) {
    const batch = await github(token, 'GET', `${path}?per_page=100&page=${page}`)
    items.push(...batch)
    if (batch.length < 100) return items
  }
}

// Posts the comment, or edits the one an earlier build posted. If no page changed, it deletes the earlier comment.
async function commentOnPr ({ token, pr, previewUrl, pages }) {
  const files = await githubList(token, `/repos/${REPO}/pulls/${pr}/files`)
  const body = renderComment(files.map((file) => file.filename), pages, previewUrl)
  const comments = await githubList(token, `/repos/${REPO}/issues/${pr}/comments`)
  const earlier = comments.find((comment) => comment.body.startsWith(HEADING))
  if (!body) {
    if (earlier) await github(token, 'DELETE', `/repos/${REPO}/issues/comments/${earlier.id}`)
    return
  }
  if (earlier) await github(token, 'PATCH', `/repos/${REPO}/issues/comments/${earlier.id}`, { body })
  else await github(token, 'POST', `/repos/${REPO}/issues/${pr}/comments`, { body })
}

module.exports = function previewPagesPlugin () {
  return {
    name: 'preview-pages',

    async postBuild ({ plugins, siteConfig }) {
      const { CONTEXT, REVIEW_ID, DEPLOY_PRIME_URL } = process.env
      if (CONTEXT !== 'deploy-preview') return
      try {
        await commentOnPr({
          token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || new URL(process.env.GIT_CREDENTIALS).username,
          pr: REVIEW_ID,
          previewUrl: DEPLOY_PRIME_URL,
          pages: pageMap(plugins, siteConfig),
        })
      } catch (err) {
        console.warn(`[preview-pages] Could not comment on PR ${REVIEW_ID}: ${err.message}`)
      }
    },
  }
}

Object.assign(module.exports, { pageMap, renderComment, commentOnPr })
