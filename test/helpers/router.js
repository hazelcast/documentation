'use strict'

const {matchPath} = require('react-router')

module.exports = {
  matchPath,
  useLocation: () => ({pathname: globalThis.__hzTestClient.pathname}),
}
