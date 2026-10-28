'use strict'

// Prints the text of the PR comment that links a PR's changed pages in its deploy preview.
// If no page changed, it prints nothing, and .github/workflows/preview-links.yml posts no comment.
// Usage: node .github/scripts/preview-links <changed-files.txt> <preview-pages.json> <preview-url>
// preview-pages.json comes from plugins/preview-pages. Files with no page of their own, such as partials and
// images, are left out.

const fs = require('node:fs')

const MAX_LINKS = 10

function renderComment (changedFiles, pages, previewUrl) {
  const urls = [...new Set(changedFiles.filter((file) => pages[file]).map((file) => pages[file]))]
  if (urls.length === 0) return ''
  const heading = urls.length === 1 ? 'Direct preview link to changed page:' : 'Direct preview links to changed pages:'
  const lines = [heading, '']
  for (const url of urls.slice(0, MAX_LINKS)) lines.push(`- [${url}](${previewUrl.replace(/\/$/, '')}${url})`)
  if (urls.length > MAX_LINKS) lines.push(`- and ${urls.length - MAX_LINKS} more`)
  return lines.join('\n') + '\n'
}

if (require.main === module) {
  const [filesPath, pagesPath, previewUrl] = process.argv.slice(2)
  const changedFiles = fs.readFileSync(filesPath, 'utf8').split('\n').filter(Boolean)
  const pages = JSON.parse(fs.readFileSync(pagesPath, 'utf8'))
  process.stdout.write(renderComment(changedFiles, pages, previewUrl))
}

module.exports = { renderComment }
