<p align="center">
  <img src="./static/img/hazelcast-logo-original.svg" alt="Hazelcast logo" width="400">
</p>

# Hazelcast Documentation

This repository holds the user documentation for [Hazelcast](https://hazelcast.com/).

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

For a versioned component, the component folder holds the unreleased version (`main`), except for CLC, where `main` is the newest release. Each `<component>_versioned_docs/version-X.Y/` folder holds the pages of one released version, and `<component>_versions.json` lists the released versions, newest first. A released version's pages can be edited at any time.

## Local development

This section covers running, building, and checking the site on your machine.

### Requirements

You need:
- Node 20 or later.
- Optional: a GitHub token with read access to internal Hazelcast repos, to render the API reference pages. See [GitHub token](MAINTAINING.md#github-token).
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
| `npm run backport -- <version>...`       | Apply your changes to other versions. See [Changing content for several versions](CONTRIBUTING.md#changing-content-for-several-versions). |
| `npm run test:version-update`            | Run the tests for the release script.                                                      |
| `npm run test:backport`                  | Run the tests for the backport script.                                                     |
| `mvn test -Dversion.hazelcast=<version>` | Compile-check the Java in `hazelcast/examples/`.                                           |

## Repository layout

The navigation sidebar for each component is generated from its folder tree. Order and labels are set by `_category_.json` and by `sidebar_position` in page frontmatter.

Content pages sit alongside their partials and images:
- `<component>/_partials/` holds reusable MDX fragments.
- `<component>/**/images/` holds images next to the pages that use them.
- `hazelcast/examples/` holds the code that Platform pages import as code blocks.

The code that builds the site is in these folders:
- `src/` holds site code: components, theme overrides, remark plugins, and non-docs pages.
  - `src/variables.ts` holds version numbers and other single-sourced values.
  - `src/currentVersions.json` holds each versioned component's `main` URL segment.
  -  `src/redirects.ts` holds redirects from old page URLs.
- `plugins/` holds local Docusaurus plugins.
- `static/` holds files served as-is, such as `static/_redirects`.
- `.github/` holds CI workflows and the release script.
- `migration/` holds throwaway tooling from the Antora migration. See [Migration tooling](MAINTAINING.md#migration-tooling).
- `AGENTS.md` holds instructions for AI coding agents working in this repo.

## Contributing

To fix or add a page, see [CONTRIBUTING.md](CONTRIBUTING.md). It covers page frontmatter, links, redirects, variables, code examples, and components.

## Maintaining the site

Releases, deployment, external content, and third-party services are covered in [MAINTAINING.md](MAINTAINING.md).
