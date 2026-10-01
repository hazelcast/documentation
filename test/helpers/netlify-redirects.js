'use strict'

// Follows static/_redirects the way Netlify applies it, for the forced (`!`) rules, which apply whether or not a file
// exists. Rules are tried top to bottom and the first match wins. A trailing `/*` matches the path itself and anything
// under it, and `:splat` is the remainder. A `:name` placeholder matches one path segment.

const fs = require('node:fs')
const path = require('node:path')
const {site} = require('./load-ts')

function forcedRules () {
  return fs.readFileSync(path.join(site, 'static/_redirects'), 'utf8').split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && !parts[0].startsWith('#') && parts[2].endsWith('!'))
    .map(([from, to, status]) => {
      const names = []
      const pattern = from
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\/\*$/, () => { names.push('splat'); return '(?:/(.*))?' })
        .replace(/:([A-Za-z]+)/g, (_, name) => { names.push(name); return '([^/]+)' })
      return {from, re: new RegExp(`^${pattern}/?$`), names, to, status: Number(status.slice(0, -1))}
    })
}

// The path a reader ends up on, after every redirect; a 200 rewrite ends the chain.
function follow (url, rules = forcedRules()) {
  let current = url
  for (let hop = 0; hop < 10; hop++) {
    const rule = rules.find(({re}) => re.test(current))
    if (!rule) return current
    const m = rule.re.exec(current)
    current = rule.names.reduce((to, name, i) => to.replace(`:${name}`, m[i + 1] ?? ''), rule.to)
    if (rule.status === 200) return current
  }
  throw new Error(`redirect loop from ${url}`)
}

module.exports = {forcedRules, follow}
