<p align="center">
  <img src="./static/img/hazelcast-logo-original.svg" alt="Hazelcast logo" width="400">
</p>

# Hazelcast Documentation

This repository holds the documentation for [Hazelcast](https://hazelcast.com/).

Use Hazelcast's unified real-time data platform to process streaming data, enrich it with historical context, and take instant action with standard or ML/AI-driven automation.

## What this repo contains

The site is built with [Docusaurus](https://docusaurus.io/) and published at https://docs.hazelcast.com. Each product is a separate docs component with its own folder, navbar entry, and URL prefix:

| Folder               | Product                     | URL prefix           | Versioned |
| -------------------- | --------------------------- | -------------------- | --------- |
| `hazelcast/`         | Platform                    | `/hazelcast`         | Yes       |
| `management-center/` | Management Center           | `/management-center` | Yes       |
| `operator/`          | Hazelcast Platform Operator | `/operator`          | Yes       |
| `clc/`               | Command Line Client (CLC)   | `/clc`               | Yes       |
| `cloud/`             | Hazelcast Cloud             | `/cloud`             | No        |
| `tutorials/`         | Tutorials                   | `/tutorials`         | No        |

For a versioned component, the component folder holds the unreleased version (`main`), except for CLC, where `main` is the newest release. Each `<component>_versioned_docs/version-X.Y/` folder holds the pages of one released version, and `<component>_versions.json` lists the versions. A released version's pages can be edited at any time.

## Local development

This section covers running, building, and checking the site on your machine.

### Requirements

You need:
- Node 20 or later.
- Optional: a GitHub token with read access to internal Hazelcast repos, to render the API reference pages. See [External content](#external-content).
- Optional: Java and Maven, to compile-check the code examples.

### Install

```bash
npm install
```

### Run the dev server

```bash
npm run start
```

This command starts a local server at http://localhost:3000. The server reloads most changes without a restart. The first start downloads external content into gitignored folders.

### Build and check

```bash
npm run build
```

This command generates the static site into `build/`. It fails on a broken internal link, a broken Markdown link, or a missing image. The dev server does not check links, so a broken link only shows up in the build. A missing image also shows as an error in the dev server, until you fix the path. Neither checks anchors (`#fragment`), so verify cross-page anchors yourself.

These commands are also available:
| Command                                  | Purpose                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run serve`                          | Serve the last build locally.                                                              |
| `npm run typecheck`                      | Type-check the TypeScript in `src/`, `plugins/`, and `docusaurus.config.ts`.               |
| `npm run clear`                          | Delete Docusaurus caches and generated files. Use it when the site behaves inconsistently. |
| `npm run test:version-update`            | Run the tests for the release script.                                                      |
| `mvn test -Dversion.hazelcast=<version>` | Compile-check the Java in `hazelcast/examples/`.                                           |

## Repository layout

The navigation sidebar for each component is generated from its folder tree. Order and labels are set by `_category_.json` and by `sidebar_position` in page frontmatter.

Content pages sit alongside their partials and images:
- `<component>/_partials/` holds reusable MDX fragments.
- `<component>/**/images/` holds images next to the pages that use them.
- `hazelcast/examples/` holds the code that Platform pages import as code blocks.

The code that builds the site is in these folders:
- `src/` holds site code: components, theme overrides, remark plugins, and non-docs pages. `src/variables.ts` holds version numbers and other single-sourced values, `src/currentVersions.json` holds each versioned component's `main` URL segment, and `src/redirects.ts` is regenerated whole. Do not edit it.
- `plugins/` holds local Docusaurus plugins.
- `static/` holds files served as-is, such as `static/_redirects`.
- `.github/` holds CI workflows and the release script.
- `migration/` holds throwaway tooling from the Antora migration. See [Migration tooling](#migration-tooling).

## Writing pages

A page starts with YAML frontmatter, usually `title`, `sidebar_label`, `sidebar_position`, and `slug`. Page URLs are public. Do not change a `slug` or move a page without adding a redirect to the `redirects` array in `docusaurus.config.ts`.

Link to another page with a relative path to its file, including the extension. For example, Do not hardcode a version number in an internal link. A link to `/<component>/latest/...` resolves to the newest release at build time.

### Variables and versions

Never type a version number or product name into prose. Use `<Variable name="full-version"/>`, or add the `vars` flag to a code fence and write `{full-version}` inside it. Values are defined per component and per version in `src/variables.ts`, and the release script updates them.

Wrap text that applies only to the unreleased version in `<IfSnapshot>`, and text that applies only to releases in `<IfNotSnapshot>`.

### Code examples

Code that a reader is expected to run lives in a file and is imported into the page with a `?tag=name` suffix, in order to single-source it. The Java in `hazelcast/examples/` is compile-checked in CI. Tutorial code is fetched from public repos and pinned to a commit. See [External content](#external-content).

### Components

These components are available in every page without an import: `Variable`, `Badge`, `IfSnapshot`, `IfNotSnapshot`, `Icon`, `Anchor`, `CodeCallouts`, and `ApiReference`. They are registered in `src/theme/MDXComponents.tsx`. Tabs need an import from `@theme/Tabs` and `@theme/TabItem`.

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

Both plugins read a token from `GITHUB_TOKEN`, then `GH_TOKEN`. The specs plugin also accepts `GIT_CREDENTIALS` (`https://<token>@github.com`). The code-example repos are public. For those, a token only raises GitHub's rate limit. The spec repos are private. For those, the token needs read access. If you use the GitHub CLI:

```bash
GITHUB_TOKEN=$(gh auth token) npm run start
```

Without a token, the dev server uses whatever specs are already downloaded and logs that they were not checked. API pages whose spec was never downloaded do not render. A build without a token fails if any spec is missing, and warns that the specs it did publish were not checked. In CI, the default Actions `GITHUB_TOKEN` cannot read other repos. Use a token with read access to the spec repos.

### Loaded in the reader's browser

The reader's browser fetches these on page load, not at build time. The build does not depend on them:
| Content                      | Loaded by                                   | Source                                                                                                                                       |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy policy text          | `src/pages/privacy.tsx`                     | hazelcast.com WordPress API. The endpoint only allows requests from docs.hazelcast.com. The page is empty on the dev server and on previews. |
| Promo banner                 | `src/components/PromoBanner`                | hazelcast.com WordPress API. Usually returns no banner, which is normal.                                                                     |
| Analytics and cookie consent | Google Tag Manager (`docusaurus.config.ts`) | Google Tag Manager, which also loads the consent manager                                                                                     |
| Search                       | Algolia (`docusaurus.config.ts`)            | Algolia                                                                                                                                      |
| AI assistant                 | `src/clientModules/kapa.ts`                 | Kapa widget script                                                                                                                           |

## Deployment

The site is deployed with Netlify. TODO: document the workflow.

## Releasing a version

When a product is released, its docs version changes: the release's version numbers, and for a major or minor release a new version of the docs and a new version for `main`. One script, `.github/scripts/version-update`, makes those changes for every versioned product, and a PR carries them to `main`.

There are three ways to run it:
- **Platform releases** run it through `package.yml` (opens a draft PR) and `promote.yml` (merges it), which the Hazelcast release pipeline calls. You only need the other two for a Platform release if the pipeline cannot be used.
- **The Version update workflow** (`version-update.yml`) runs it from the Actions tab for any product and opens a PR. Tick **merge** to have it merge the PR once its checks pass. A product's own release workflow can call it the same way: `gh workflow run version-update.yml -R hazelcast/documentation -f component=clc -f version=5.5.2`.
- **Locally**, from the repo root on an up-to-date `main`. Add `--dry-run` to see the changes without making them.

The command for each product:
| Product           | Patch release                                                       | Major or minor release                                                                            |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Platform          | `node .github/scripts/version-update hazelcast 5.7.2`               | `node .github/scripts/version-update hazelcast 6.0.0 --next 6.1.0-SNAPSHOT`                       |
| Management Center | `node .github/scripts/version-update management-center 5.11.2`      | `node .github/scripts/version-update management-center 5.12.0 --next 5.13.0-SNAPSHOT`             |
| Operator          | `node .github/scripts/version-update operator 5.19.1 --next 5.20.0` | `node .github/scripts/version-update operator 5.20.0 --next 5.21.0 --hazelcast 5.7.1 --mc 5.11.1` |
| CLC               | `node .github/scripts/version-update clc 5.5.2`                     | `node .github/scripts/version-update clc 5.6.0`                                                   |

The `--next` option sets the version `main` moves to: the product's next development version for a Platform or Management Center major or minor release, and the upcoming release for Operator (needed on every Operator release). In the Version update workflow these are two separate inputs, `next-snapshot` and `next-release`. The `--hazelcast` and `--mc` options (`supported-hazelcast` and `supported-mc` in the workflow) set Operator's latest supported Platform and Management Center versions. The script leaves them unchanged when omitted.

What a release changes:
- **Patch release**: that version's variables in `src/variables.ts`. For Management Center, also its `mc-repo-swagger-branch` and a `release-notes/X-Y-Z` redirect to the release notes page, which the downloads page links to.
- **Major or minor release**: a copy of the product's current docs becomes the new version (`<product>_versioned_docs/version-X.Y`, `<product>_versions.json`, its variables, redirects and `static/` files), and `main` moves on: `src/currentVersions.json`, `main`'s variables, and the `latest`/`latest-dev` rules in `static/_redirects`. Links in the copy that pointed at `main`'s version now point at the new one. Operator's `main` is always `latest-snapshot`, and the script does not rename it.
- **CLC**: Because `main` is always CLC's newest release, every CLC release copies `main` to a version named after the outgoing release and renames `main` to the new one. Merge the new release's content after the version update, in order to keep the outgoing content in the outgoing copy.

Platform and Management Center releases also update each other's "latest supported" pointer (`page-latest-supported-mc`, `page-latest-supported-hazelcast`).

The script refuses a release it cannot make, such as a beta, a line other than the one `main` is on, or a version that already exists, and refuses to rewrite a file it would have to reformat. It does not change the search index's version list (the crawler config in Algolia), release notes, Operator's API reference, or compatibility values it is not given. The tests run with `npm run test:version-update`.

## Static assets

Images are co-located with the pages that use them. Webpack resolves and content-hashes each one, and a missing image fails the build. `static/` is for the exceptions: files that must keep a fixed URL, such as `static/_redirects` and downloadable attachments.

## Contributing

TODO: document the contribution and review process.

## Migration tooling

The `migration/` folder holds disposable tooling used to convert the Antora content to Docusaurus. It has its own `package.json`, and normal site work does not need it. See `migration/README.md` before using it.
