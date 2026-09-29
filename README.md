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

## External content

Some content is not stored in this repo. It is fetched from elsewhere, either by a plugin when the dev server starts or the site builds, or by the reader's browser when a page loads.

### Fetched when the server starts or the site builds

Each source is downloaded into a gitignored directory, and the pages read it from there:

| Content                                   | Plugin                      | Downloaded into       | Source                                                                             | Updates            | GitHub Token |
| ----------------------------------------- | --------------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------ | ------------ |
| Tutorial code examples                    | `plugins/tutorial-examples` | `.tutorial-examples/` | Public `hazelcast-guides/*` repos, listed in `tutorials/examples.json`             | Pinned to a commit | Optional     |
| Operator tutorial code examples           | `plugins/tutorial-examples` | `.tutorial-examples/` | Public `hazelcast/hazelcast-code-samples` repo, listed in `operator/examples.json` | Pinned to a commit | Optional     |
| OpenAPI specs for the API reference pages | `plugins/openapi-specs`     | `.api-specs/`         | Private product repos, referenced by each page's `<ApiReference source>`           | Follows a branch   | Required     |

The code examples are pinned: each entry in an `examples.json` records a commit and a hash of the file's contents. A file already downloaded at its commit is never downloaded again. A failed download or a content mismatch stops both the dev server and the build.

The OpenAPI specs follow the branch each page names. The dev server downloads only specs that are missing. A build re-checks every spec against GitHub, because a build is what gets published.

#### GitHub token

Both plugins read a token from `GITHUB_TOKEN`, then `GH_TOKEN`. The specs plugin also accepts `GIT_CREDENTIALS` (`https://<token>@github.com`). The code-example repos are public, so for those a token only raises GitHub's rate limit. The spec repos are private, so the token needs read access to them. If you use the GitHub CLI:

```bash
GITHUB_TOKEN=$(gh auth token) npm run start
```

Without a token, the dev server uses whatever specs are already downloaded and logs that they were not checked. API pages whose spec was never downloaded will not render. A build without a token fails if any spec is missing, and warns that the specs it did publish were not checked. In CI, the default Actions `GITHUB_TOKEN` cannot read other repos, so use a token with read access to the spec repos.

### Loaded in the reader's browser

These are fetched on page load, not at build time, so the build does not depend on them:

| Content                      | Loaded by                                   | Source                                                                                                                                          |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy policy text          | `src/pages/privacy.tsx`                     | hazelcast.com WordPress API. The endpoint only allows requests from docs.hazelcast.com, so the page is empty on the dev server and on previews. |
| Promo banner                 | `src/components/PromoBanner`                | hazelcast.com WordPress API. Usually returns no banner, which is normal.                                                                        |
| Analytics and cookie consent | Google Tag Manager (`docusaurus.config.ts`) | Google Tag Manager, which also loads the consent manager                                                                                        |
| Search                       | Algolia (`docusaurus.config.ts`)            | Algolia                                                                                                                                         |
| AI assistant                 | `src/clientModules/kapa.ts`                 | Kapa widget script                                                                                                                              |

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

## Releasing a version

When a product is released, its docs version changes: the release's version numbers, and for a major or minor release a new version of the docs and a new version for `main`. One script, `.github/scripts/version-update`, makes those changes for every versioned product, and a PR carries them to `main`.

There are three ways to run it:

- **Platform releases** run it through `package.yml` (opens a draft PR) and `promote.yml` (merges it), which the Hazelcast release pipeline calls. You only need the other two for a Platform release if the pipeline can't be used.
- **The Version update workflow** (`version-update.yml`) runs it from the Actions tab for any product and opens a PR. Tick **merge** to have it merge the PR once its checks pass. A product's own release workflow can call it the same way: `gh workflow run version-update.yml -R hazelcast/documentation -f component=clc -f version=5.5.2`.
- **Locally**, from the repo root on an up-to-date `main`. Add `--dry-run` to see the changes without making them.

| Product | Patch release | Major or minor release |
| --- | --- | --- |
| Platform | `node .github/scripts/version-update hazelcast 5.7.2` | `node .github/scripts/version-update hazelcast 6.0.0 --next 6.1.0-SNAPSHOT` |
| Management Center | `node .github/scripts/version-update management-center 5.11.2` | `node .github/scripts/version-update management-center 5.12.0 --next 5.13.0-SNAPSHOT` |
| Operator | `node .github/scripts/version-update operator 5.19.1 --next 5.20.0` | `node .github/scripts/version-update operator 5.20.0 --next 5.21.0 --hazelcast 5.7.1 --mc 5.11.1` |
| CLC | `node .github/scripts/version-update clc 5.5.2` | `node .github/scripts/version-update clc 5.6.0` |

`--next` is the version `main` moves to: the product's next development version for a Platform or Management Center major or minor release, and the upcoming release for Operator (needed on every Operator release). In the Version update workflow these are two separate inputs, `next-snapshot` and `next-release`. `--hazelcast` and `--mc` (`supported-hazelcast` and `supported-mc` in the workflow) set Operator's latest supported Platform and Management Center versions, and are left unchanged when omitted.

What a release changes:

- **Patch release**: that version's variables in `src/variables.ts`. For Management Center, also its `mc-repo-swagger-branch` and a `release-notes/X-Y-Z` redirect to the release notes page, which the downloads page links to.
- **Major or minor release**: a copy of the product's current docs becomes the new version (`<product>_versioned_docs/version-X.Y`, `<product>_versions.json`, its variables, redirects and `static/` files), and `main` moves on: `src/currentVersions.json`, `main`'s variables, and the `latest`/`latest-dev` rules in `static/_redirects`. Links in the copy that pointed at `main`'s version now point at the new one. Operator's `main` is always `latest-snapshot`, so it isn't renamed.
- **CLC**: `main` is always CLC's newest release, so every CLC release copies `main` to a version named after the outgoing release and renames `main` to the new one. Merge the new release's content after the version update, so the outgoing copy keeps the outgoing content.

Platform and Management Center releases also update each other's "latest supported" pointer (`page-latest-supported-mc`, `page-latest-supported-hazelcast`).

The script refuses a release it can't make, such as a beta, a line other than the one `main` is on, or a version that already exists, and refuses to rewrite a file it would have to reformat. It doesn't change the search index's version list (the crawler config in Algolia), release notes, Operator's API reference, or compatibility values it isn't given. The tests run with `npm run test:version-update`.

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
