'use strict'

const React = require('react')

// Marks its output so a test can tell a Link, which the build's broken-link check sees, from a plain <a>.
module.exports = ({to, children}) => React.createElement('a', {href: to, 'data-docusaurus-link': ''}, children)
