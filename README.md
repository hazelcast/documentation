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
file corpus-wide, adding a subsystem for it was not worth it. It sits at
Antora's published URL so the production URL is preserved and the converter's
generated link resolves unchanged, with one copy per live version to match the
per-version image rule.

Because it lives in `static/` rather than being co-located, the broken-link
checker (which only sees routes) still warns on each referring page, and
webpack never verifies the file, so deleting it 404s silently instead of
failing the build. Both are acceptable while the Antora sources stay pinned.
