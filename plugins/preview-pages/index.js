'use strict'

// In Netlify deploy previews, comments on the PR with direct links to the pages it changes. The URLs come from
// the docs plugins' loaded content, so slugs and versions resolve exactly as the site serves them. Files with no
// page of their own, such as partials and images, are left out. A failure only logs a warning.
// Netlify sets CONTEXT, REVIEW_ID (the PR number), and DEPLOY_PRIME_URL (the preview URL). The token needs
// write access to the repo's pull requests.

const DOCS_PLUGIN_NAME = 'docusaurus-plugin-content-docs'
const REPO = 'hazelcast/documentation'
const HEADING = 'Direct preview link'
const MAX_LINKS = 10

// Each doc's source file mapped to its URL path, e.g. { "hazelcast/sql/index.mdx": "/hazelcast/6.0-snapshot/sql" }.
function pageMap (plugins) {
  const map = {}
  for (const plugin of plugins.filter((p) => p.name === DOCS_PLUGIN_NAME)) {
    for (const version of plugin.content?.loadedVersions ?? []) {
      for (const doc of version.docs) map[doc.source.replace(/^@site\//, '')] = doc.permalink
    }
  }
  return map
}

// The comment text, or '' if no page changed.
function renderComment (changedFiles, pages, previewUrl) {
  const urls = [...new Set(changedFiles.filter((file) => pages[file]).map((file) => pages[file]))]
  if (urls.length === 0) return ''
  const heading = urls.length === 1 ? `${HEADING} to changed page:` : `${HEADING}s to changed pages:`
  const lines = [heading, '']
  for (const url of urls.slice(0, MAX_LINKS)) lines.push(`- [${url}](${previewUrl.replace(/\/$/, '')}${url})`)
  if (urls.length > MAX_LINKS) lines.push(`- and ${urls.length - MAX_LINKS} more`)
  return lines.join('\n') + '\n'
}

async function github (token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: body && JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}`)
  return res.json()
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

// Posts the comment, or edits the one an earlier build posted. If no page changed, it posts no comment.
async function commentOnPr ({ token, pr, previewUrl, pages }) {
  const files = await githubList(token, `/repos/${REPO}/pulls/${pr}/files`)
  const body = renderComment(files.map((file) => file.filename), pages, previewUrl)
  if (!body) return
  const comments = await githubList(token, `/repos/${REPO}/issues/${pr}/comments`)
  const earlier = comments.find((comment) => comment.body.startsWith(HEADING))
  if (earlier) await github(token, 'PATCH', `/repos/${REPO}/issues/comments/${earlier.id}`, { body })
  else await github(token, 'POST', `/repos/${REPO}/issues/${pr}/comments`, { body })
}

module.exports = function previewPagesPlugin () {
  return {
    name: 'preview-pages',

    async postBuild ({ plugins }) {
      const { CONTEXT, REVIEW_ID, DEPLOY_PRIME_URL } = process.env
      if (CONTEXT !== 'deploy-preview') return
      try {
        await commentOnPr({
          token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || new URL(process.env.GIT_CREDENTIALS).username,
          pr: REVIEW_ID,
          previewUrl: DEPLOY_PRIME_URL,
          pages: pageMap(plugins),
        })
      } catch (err) {
        console.warn(`[preview-pages] Could not comment on PR ${REVIEW_ID}: ${err.message}`)
      }
    },
  }
}

Object.assign(module.exports, { pageMap, renderComment, commentOnPr })
