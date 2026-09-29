# Contributing to the Hazelcast documentation

This file is for AI coding agents working in this repository. Humans are welcome to read it too. It covers what the repo is, how it is laid out, how to run and check it, and how to write content for it.

## What this repo is

This repository is the source of the Hazelcast documentation site, published at https://docs.hazelcast.com. It is a [Docusaurus](https://docusaurus.io/) site (v3, React 19, TypeScript, MDX) that replaces an earlier Antora/AsciiDoc site. The pages are MDX files that you edit directly.

The site holds the documentation for several products, each a separate docs component with its own navbar entry, sidebar, and URL prefix:

| Folder | Product | URL prefix | Versioned |
| --- | --- | --- | --- |
| `hazelcast/` | Platform | `/hazelcast` | Yes |
| `management-center/` | Management Center | `/management-center` | Yes |
| `operator/` | Hazelcast Platform Operator | `/operator` | Yes |
| `clc/` | Command Line Client (CLC) | `/clc` | Yes |
| `cloud/` | Hazelcast Cloud | `/cloud` | No |
| `tutorials/` | Tutorials | `/tutorials` | No |

A component's folder ID (`hazelcast`, `management-center`, `operator`, `clc`, `cloud`, `tutorials`) is also its plugin ID. It is the key used in `src/variables.ts`, `src/currentVersions.json`, and the `<id>_versions.json` files.

## Repository layout

- `<component>/` holds the pages of the unreleased version, which Docusaurus calls `current` and this repo calls `main`. The exception is CLC, where `main` is always the newest release. Subfolders become sidebar categories, labeled and ordered by `_category_.json` and `sidebar_position`. There is no hand-written sidebar file.
- `<component>_versioned_docs/version-X.Y/` holds the pages of each released version, which can be edited at any time, and `<component>_versions.json` lists the versions, newest first. A fix that applies to several versions must be made in each folder. Never create a version by copying folders. The version-update script does that. See [Releasing a version](README.md#releasing-a-version).
- `<component>/_partials/` holds reusable MDX fragments, imported with `import Partial from '@site/<component>/_partials/name.mdx'`.
- `<component>/**/images/` holds images next to the pages that use them, referenced as `./images/name.png`.
- `hazelcast/examples/` holds the code that pages import. See [Code examples](#code-examples).
- `src/` holds site code: components, theme overrides, remark plugins, and non-docs pages. Three files matter to content:
  - `src/variables.ts` holds version numbers and other single-sourced values.
  - `src/currentVersions.json` holds each versioned component's `main` URL segment.
  - `src/redirects.ts` is regenerated whole, so do not edit it. Add a hand-written redirect to the `redirects` array in `docusaurus.config.ts`.
- `plugins/` holds local Docusaurus plugins, and `.github/` holds CI and the release script.
- `migration/` holds throwaway Antora conversion tooling with its own `package.json`. Ignore it unless your task is the migration, and never import from it.

Never edit or commit generated directories: `build/`, `.docusaurus/`, `.api-specs/`, `.tutorial-examples/`, `target/`, and `*_versioned_sidebars/`.

## Running the site

Node 20 or later is required. CI uses Node 22 and 24.

```bash
npm install
```

```bash
npm run start
```

The dev server runs at http://localhost:3000 and reloads on most changes. The first start downloads external content (tutorial code examples and OpenAPI specs) into gitignored folders. The OpenAPI specs come from private repos, so API reference pages only render if a GitHub token with read access is available. See [External content](README.md#external-content).

```bash
GITHUB_TOKEN=$(gh auth token) npm run start
```

`npm run build` runs the production build into `build/`, and `npm run serve` serves it.

`npm run build` produces the site that gets published. It fails on a broken internal link, a broken Markdown link, or a missing image. It does not check anchors (`#fragment`), so verify cross-page anchors yourself. Do not run it while a dev server is running in the same folder, because it overwrites the files the dev server uses.

## Commands and checks

| Command | Purpose |
| --- | --- |
| `npm run start` | Dev server with live reload. |
| `npm run build` | Production build. Fails on broken links and images. |
| `npm run serve` | Serve the last build. |
| `npm run typecheck` | Type-check the TypeScript in `src/`, `plugins/`, and `docusaurus.config.ts`. |
| `npm run clear` | Delete Docusaurus caches and generated files. Use it when the site behaves inconsistently. |
| `npm run test:version-update` | Unit tests for the release script. Run it after changing `.github/scripts/version-update`, `src/variables.ts`, `src/redirects.ts`, `src/currentVersions.json`, `*_versions.json`, or `static/_redirects`. |
| `mvn test -Dversion.hazelcast=<version>` | Compile-check the Java in `hazelcast/examples/`. Run it after changing those files. |

### Release scripts

The scripts in `.github/scripts/version-update` update version numbers when a product is released. Run them from the repo root on an up-to-date `main`, and use `--dry-run` first:

```bash
node .github/scripts/version-update hazelcast 5.7.2 --dry-run
```

The [README](README.md#releasing-a-version) has the full syntax for each product. The script refuses releases it cannot make and refuses to rewrite files it would have to reformat, so do not reformat `src/variables.ts`, `src/currentVersions.json`, or `*_versions.json`.

The checks in `migration/` need local mirrors of the Antora source repos. Run them only when working on the migration, after reading `migration/README.md`.

## Conventions for pages

### Frontmatter

Pages start with YAML frontmatter. The keys in common use are `title`, `sidebar_label`, `sidebar_position`, and `slug`. Page URLs are part of the public contract, so do not change a `slug`, rename a file whose URL depends on its path, or move a page without adding a redirect.

Pages in `cloud/` and `tutorials/` can carry `cloud_*` keys such as `cloud_tags` and `cloud_title`. They feed `/api/cloud.json`, which the Hazelcast Cloud console reads. Leave them as they are, and see `plugins/cloud-console-index/index.js` before changing one.

### Components

These components are available in every page without an import: `Variable`, `Badge`, `IfSnapshot`, `IfNotSnapshot`, `Icon`, `Anchor`, `CodeCallouts`, and `ApiReference`. They are registered in `src/theme/MDXComponents.tsx`. Tabs need an import from `@theme/Tabs` and `@theme/TabItem`.

- **Version numbers and product names**: never type them into prose. Use `<Variable name="full-version"/>`, or `<Variable href="{page-cloud-console}" text="{hazelcast-cloud} console"/>` for a link. In a code block, add the `vars` flag to the fence (` ```shell vars `) and write `{full-version}`. Values are defined per component and per version in `src/variables.ts`, and are updated by the release script.
- **Enterprise features**: mark a page or an inline mention with `<Badge type="enterprise"/>`.
- **Unreleased content**: wrap text that applies only to the snapshot version in `<IfSnapshot>`, and text that applies only to releases in `<IfNotSnapshot>`.
- **Custom heading anchors**: `## Heading {/* #custom-id */}` sets an ID. Use `<Anchor id="name"/>` for an anchor that is not a heading.
- **API reference pages**: use `<ApiReference source="…"/>` with the URL of the OpenAPI spec in the product repo.
- **Admonitions**: `:::note`, `:::tip`, `:::important`, `:::caution`, and `:::warning`. Put a blank line after the opening line and before the closing `:::`.

### Code examples

Code that a reader is expected to run should not be pasted into a page. Keep it in a file and import it, so that it is compile-checked and single-sourced:

- Java in `hazelcast/examples/` is compile-checked by Maven in CI. Mark a region of the file with a tag and import it with `?tag=name`.
- Tutorial code is fetched from public `hazelcast-guides` repos, pinned to a commit in `tutorials/examples.json` (and `operator/examples.json` for the Operator).
- `{attribute}` placeholders inside an imported example are replaced with the version's values at build time.

Follow the import pattern of the neighboring pages. Give every fence a language.

### Links

- Link to another page with a relative path to its file, including the extension: `[text](../operate-and-manage/logging.mdx)`. A broken path fails the build.
- A link to `/<component>/latest/...` resolves to the newest release at build time. Do not hardcode a version number in an internal link.
- Use descriptive link text. Never use "click here".

### Adding a page

1. Create the `.mdx` file in the folder where the reader would look for it. Keep filenames lowercase and hyphenated.
2. Add frontmatter with a `title`. Set `sidebar_position` if the page must appear somewhere other than alphabetical order.
3. Add a link to it from the pages that should lead there.
4. Run `npm run build`.

Prefer a section in an existing page to a new page, unless the topic is distinct.

## Writing style

### Who is reading

Readers are developers and operators who use Hazelcast. Assume they know Java or another client language, Docker or Kubernetes where the page is about them, and general distributed-systems terms. Do not assume they know Hazelcast concepts. Define a Hazelcast term the first time it appears on a page, or link to where it is defined.

Write for AI readers as well as human ones. Either may arrive at a section without having read the one above it, so each section states its own subject instead of inheriting it, and one concept keeps one name throughout the site. Use the product names exactly: Platform, Management Center, CLC, Operator, Cloud.

### Accuracy

- Document what is built, not what is planned. Verify every statement about product behavior against the product code, a test that pins the behavior, or a live run. Do not document from a design document, a roadmap, or memory.
- Where the answer is not knowable from what you have, do not guess. Leave a comment for the owner in the form `{/* TODO: <question> */}`. An open question is correct, and a plausible guess is not.
- Do not promise future behavior or release dates.
- State a limitation plainly. Readers use these pages to decide what to run in production.
- Release notes are generated at release time. Do not hand-edit them. Record a removal or a breaking change in the migration or upgrade guide instead.

### Voice

- Use a neutral, direct register. Avoid contractions in new text, unless the expanded form reads badly. Existing pages contain contractions. Do not rewrite a page's style as a side effect of an unrelated change.
- Write one idea per sentence. Keep to about fifteen words on average, and split anything over thirty.
- Use the present tense. Avoid "will": write "Hazelcast rejects the request", not "Hazelcast will reject the request".
- Address the reader as "you". Every sentence has a real agent: "The member closes the connection", not "the connection is closed". Avoid "we", "let's", and "our".
- Be precise. Name the thing and the action: "set the path with `--config`", not "point it somewhere else".
- Be concrete. No metaphors, and no "seamlessly", "robust", "powerful", "simply", "easily", or "very".
- Avoid the ", so" construction, which reads as either consequence or purpose. Split the sentence, or write "because" or "in order to".
- A value "increases" or "decreases". It never "rises", "grows", or "climbs".
- Do not sell the product or explain business context on a reference page.

### Mechanics

- Write one line per paragraph. Do not hard-wrap Markdown or MDX files.
- Use the Oxford comma, always.
- Use US spelling: `behavior`, not `behaviour`.
- Use sentence case for headings: "Configure a cluster", not "Configure A Cluster". Headings for tasks are imperative. Do not end a heading with a period.
- Never follow a heading directly with another heading. Open every section with at least one sentence saying what it covers.
- Introduce every table and list with a sentence ending in a colon, with no blank line between the sentence and the list. Capitalize each list item unless it begins with a code identifier.
- Never open a sentence with a lowercase code item. Rewrite it: "The `name` field", or "Hazelcast sets `name`".
- Put commands, file names, configuration keys, and class names in backticks. Put UI labels in bold.
- Make each step in a procedure one action. Say what the reader should see when it succeeds, if it is not obvious.
- Write the product name "Management Center", not "MC". Write "CLC", not "clc", in prose.
- Give a code block a language, and a `title` when it represents a file.

### Keep one explanation of each fact

Explain a fact, meaning the mechanism and the reason it behaves that way, in one place. On every other page that needs it, say what that page's reader needs and link to the explanation. Do not restate it. A feature that belongs on several pages, such as a setting that appears in a configuration guide, a reference, and a tutorial, is normal.

## Before you finish

1. Run `npm run build` and fix any errors it reports.
2. Run `npm run typecheck` if you changed TypeScript.
3. Run the other relevant checks from [Commands and checks](#commands-and-checks).
4. Check that you have not changed generated files, and that you have not reformatted files the release script rewrites.
5. If you added or moved a page, check that it appears in the sidebar and that its URL is what you intended.
