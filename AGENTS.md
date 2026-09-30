# Instructions for AI agents

This file is for AI coding agents working in this repository. It covers the rules that are specific to agents. The conventions for writing pages are in CONTRIBUTING.md, and they apply to agents in full.

## Read first

Read these files before you change anything:
- [README.md](README.md): what the repo contains, the product folders, and the repository layout.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to write and change pages, including the writing style. Follow it for every page you add or edit.
- [MAINTAINING.md](MAINTAINING.md): releases, deployment, external content, and CI. Read it before you change anything under `.github/`, `plugins/`, or `netlify.toml`.

## What this repo is

This repository is the source of the Hazelcast documentation site, published at https://docs.hazelcast.com. It is a [Docusaurus](https://docusaurus.io/) site (v3, React 19, TypeScript, MDX) that replaces an earlier Antora/AsciiDoc site. The pages are MDX files that you edit directly.

A product's folder name (`hazelcast`, `management-center`, `operator`, `clc`, `cloud`, or `tutorials`) is also its Docusaurus plugin ID. It is the key used in `src/variables.ts`, `src/currentVersions.json`, and the `<id>_versions.json` files.

## Rules for agents

Follow these rules in addition to CONTRIBUTING.md:
- Never edit or commit generated directories: `build/`, `.docusaurus/`, `.api-specs/`, `.tutorial-examples/`, `target/`, and `*_versioned_sidebars/`.
- Never create a version by copying folders. The release script does that. See [Releasing a version](MAINTAINING.md#releasing-a-version).
- A fix that applies to several versions must be made in each version's folder: `<component>/` for `main`, and `<component>_versioned_docs/version-X.Y/` for each release.
- Do not reformat the files the release script rewrites: `src/variables.ts`, `src/redirects.ts`, `src/currentVersions.json`, `static/_redirects`, and `*_versions.json`. If their formatting changes, the release script stops working.
- Do not run `npm run build` while a dev server is running in the same folder. The build overwrites the files the dev server uses.
- Ignore `migration/` unless your task is the migration, and never import from it. It holds throwaway Antora conversion tooling with its own `package.json`. Its checks need local mirrors of the Antora source repos. Read `migration/README.md` before running them.
- Before you change a `cloud_*` frontmatter key, read `plugins/cloud-console-index/index.js`. The keys feed `/api/cloud.json`, which the Hazelcast Cloud console reads.
- An imported code example can contain `{attribute}` placeholders. The build replaces them with the version's values. Do not replace them with literal values.
- When you are unsure how to write something, follow the pattern of the neighboring pages.

## Running the site

The OpenAPI specs for the API reference pages come from private repos. Without a GitHub token, those pages do not render. If the GitHub CLI is available, start the dev server with a token:

```bash
GITHUB_TOKEN=$(gh auth token) npm run start
```

See [GitHub token](MAINTAINING.md#github-token) for the other ways to provide one.

## Commands and checks

Run the checks that match what you changed:

| Command                                  | Run it after changing                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                          | Anything. It fails on a broken internal link, a broken Markdown link, or a missing image. It does not check anchors (`#fragment`), so verify cross-page anchors yourself.  |
| `npm run typecheck`                      | TypeScript in `src/`, `plugins/`, or `docusaurus.config.ts`.                                                                                                               |
| `npm run test:version-update`            | `.github/scripts/version-update/`, or any file it rewrites: `src/variables.ts`, `src/redirects.ts`, `src/currentVersions.json`, `*_versions.json`, or `static/_redirects`. |
| `mvn test -Dversion.hazelcast=<version>` | Java in `hazelcast/examples/`.                                                                                                                                             |

## Before you finish

Check your work:
1. Run `npm run build` and fix any errors it reports.
2. Run the other checks from [Commands and checks](#commands-and-checks) that match your change.
3. Check that you have not changed generated files, and that you have not reformatted files the release script rewrites.
4. If you added or moved a page, check that it appears in the side navigation and that its URL is what you intended. If a page's URL changed, check that you added a redirect.
5. If you wrote or edited prose, reread it against [Writing style](CONTRIBUTING.md#writing-style) and fix anything that breaks a rule. Check only the text you changed.
