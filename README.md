# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

## Installation

```bash
npm install
```

**Note**: feel free to use the package manager of your choice.

## Local Development

```bash
npm run start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

Using SSH:

```bash
USE_SSH=true npm run deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> npm run deploy
```

If you are using GitHub Pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.

## Static assets

Images are co-located with the pages that use them and placed by
`migration/extract-images.js`, so webpack resolves and content-hashes each one
and a missing image fails the build. `static/` is for the exceptions.

`static/hazelcast/<version>/pipelines/_attachments/nasdaqlisted.txt` is one:
the corpus's only Antora *attachment* (from `hz-docs`
`docs/modules/pipelines/attachments/`), a data file the `map-join` tutorial
tells the reader to download. Attachments are a different Antora resource
family from images, so nothing in the converter places them — with a single
file corpus-wide, adding a subsystem for it was not worth it. One copy per live
version, matching the per-version image rule.

Note what actually happens to the link. The converter emits Antora's published
absolute URL, and for an ABSOLUTE asset path Docusaurus searches the static
dirs (mdx-loader `remark/transformLinks`, `getLocalFileAbsolutePath`); finding
the file there, it rewrites the link to a content-hashed
`/assets/files/nasdaqlisted-<hash>.txt` require. So the referring pages link to
the hashed asset, webpack DOES verify it (deleting it fails the build, as with
a co-located image), and the copies under `static/` serve only to keep Antora's
production URL alive for inbound links and bookmarks.

The trade-off is duplication: six static copies plus one hashed asset for a
195 KB file. To make the pages use the production URL instead, the link would
need Docusaurus's `pathname://` prefix to opt out of asset processing — at the
cost of the build-time verification and of a broken-link warning, since the
checker only sees routes.
