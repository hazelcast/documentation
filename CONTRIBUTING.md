# Contributing to the Hazelcast documentation

This guide covers how to write and change pages in this repo. To run the site locally, see [Local development](README.md#local-development).

## Page structure

Each documentation page is built from an MDX file. Each file starts with YAML frontmatter:
- `title`: the page title.
- `sidebar_label`: the label that's shown in the side navigation.
- `sidebar_position`: the position of this page within its section in the side navigation.
- `slug`: used to maintain URLs from the previous documentation platform. Don't add a slug for new pages, or edit existing slugs.
- `enterprise: true`, `beta: true`, or `experimental: true`: shows a badge at the top of the page. The `enterprise` and `beta` badges also show next to the page in the side navigation.

Pages in `cloud/` and `tutorials/` can also have `cloud_title`, `cloud_tags`, and `cloud_order` keys. The Hazelcast Cloud console reads them, so do not remove or rename them.

## Adding a page

To add a page:
1. Create an `.mdx` file in the folder where a reader would look for it. Use a lowercase, hyphenated file name, e.g. `configure-tls.mdx`.
2. Add frontmatter with a `title`. Add `sidebar_position` if the page must not appear in alphabetical order. Do not add a `slug`.
3. Link to the new page from the pages that should lead to it.
4. Run `npm run build` and check that the page appears in the side navigation.

To add a folder, which becomes a section in the side navigation, add a `_category_.json` file to it:

```json
{
  "label": "Connectors",
  "position": 5
}
```

Prefer a new section in an existing page to a new page, unless the topic is distinct.

## Links and redirects

Link to another page in the same product with a relative path to its file, including the extension, e.g. `../mc-conf.mdx`. Link to a page in another product with its URL path, starting with `/`. For a versioned product, use `latest` as the version, e.g. `/hazelcast/latest/sql/sql-statements`. The build resolves `latest` to the newest release. For Cloud and Tutorials, leave out the version, e.g. `/tutorials/write-through-cache-serverless-mapstore`. Do not hardcode a version number in an internal link.

If a change alters a page's URL, add a redirect from the old URL to the new one in `src/redirects.ts`, e.g. `{ from: "/hazelcast/6.0-snapshot/old-name", to: "/hazelcast/6.0-snapshot/new-name" },`. A page's URL changes when you edit its `slug`, or when you rename or move a page that has no `slug`. The build fails if a redirect points at a page that does not exist. Do not edit `static/_redirects`. The release script maintains it.

## Variables and versions

Never type a version number or product name into prose. Values are defined per component and per version in `src/variables.ts`, and the release script updates them. To insert a value:
- In prose, use the `Variable` component, e.g. `<Variable name="full-version"/>`.
- In a link, write the value in braces inside `href` or `text`, e.g. `<Variable href="https://github.com/hazelcast/hazelcast/blob/v{os-version}/pom.xml" text="pom.xml"/>`.
- In a code block, add the `vars` flag to the fence and write the value in braces:

````md
```xml vars
<version>{full-version}</version>
```
````

Wrap text that applies only to the unreleased version in `<IfSnapshot>`, and text that applies only to releases in `<IfNotSnapshot>`. Leave a blank line inside each tag:

```md
<IfSnapshot>

This feature is in beta.

</IfSnapshot>
```

## Changing content for several versions

Each version of a product has its own folder: `<product>/` for `main`, and `<product>_versioned_docs/version-X.Y/` for each release. Make the change in one version, then copy it to the others with the backport script:

```bash
npm run backport -- 5.7 5.6
```

The script takes your uncommitted changes, including new files, and applies them to the same files in each version you name. Name a release by its number, and `main` as `current`. To apply a commit instead, add `--commit <ref>`. To see what would happen without changing any files, add `--dry-run`.

The script merges your change into each version's copy of the file, so text that differs between versions is kept. It lists each file with one of these results:
- `applied`: the change is in the file.
- `unchanged`: the file already had the change.
- `conflict`: the change clashed with that version's text. Resolve the `<<<<<<<` markers in the file.
- `not applied`: the script could not apply the change, for example because a new file already exists in that version with different content. Make the change by hand.
- `missing`: the version has no file at that path. The page might not exist in that version, or it might be at a different path. If it is at a different path, make the change by hand.

The script exits with 1 if any file needs your attention. It only changes files in a version's folder. If you changed other files, such as `src/redirects.ts`, the script's output names them and leaves them alone.

If you changed files in more than one version of a product, add `--from <version>` to say which version's changes to apply. Review the result with `git diff` before you commit.

## Code examples

Short snippets, such as shell commands and configuration fragments, go directly in the page in a code fence. Java examples are kept in separate files instead, which CI compiles to catch examples that no longer match the API. A page imports the file and displays it in a `CodeBlock`, and several pages can import the same file.

Platform examples are in `hazelcast/examples/`. To show only part of a file, mark the part with tags:

```java
//tag::ejc[]
Config config = new Config();
//end::ejc[]
```

Then import the file with `?tag=` and the tag name, and display it:

```mdx
import CodeBlock from "@theme/CodeBlock";
import EventJournal from "../../examples/dds/EventJournalConfiguration.java?tag=ejc";

<CodeBlock language="java">{EventJournal}</CodeBlock>
```

Leave out `?tag=` to show the whole file. The Java in `hazelcast/examples/` is compile-checked in CI.

Tutorial and Operator examples are not stored in this repo. They are fetched from public GitHub repos at a pinned commit, listed in `tutorials/examples.json` and `operator/examples.json`. See [External content](MAINTAINING.md#external-content).

## Components

These components are available in every page without an import: `Variable`, `Badge`, `IfSnapshot`, `IfNotSnapshot`, `Icon`, `Anchor`, `CodeCallouts`, and `ApiReference`. For `Variable`, `IfSnapshot`, and `IfNotSnapshot`, see [Variables and versions](#variables-and-versions). For `Icon` and `CodeCallouts`, follow an existing page that uses them.

To mark a feature as Enterprise-only inside a page, use a badge:

```mdx
Persistence <Badge type="enterprise"/> stores map data on disk.
```

To mark a whole page, use the `enterprise` frontmatter key instead.

To show an API reference page, point `ApiReference` at the OpenAPI spec in the product repo:

```mdx
<ApiReference source="https://github.com/hazelcast/management-center/blob/{mc-repo-swagger-branch}/hazelcast-management-center/src/openapi/external/rest-client-api.yaml"/>
```

Tabs need an import. Leave a blank line inside each `TabItem`:

```mdx
import Tabs from "@theme/Tabs";
import TabItem from "@theme/TabItem";

<Tabs groupId="config-format">
<TabItem value="xml" label="XML">

XML configuration goes here.

</TabItem>
<TabItem value="yaml" label="YAML">

YAML configuration goes here.

</TabItem>
</Tabs>
```

Tabs with the same `groupId` switch together, on the same page and across the site.

## Partials

A partial is a fragment of MDX that several pages share. Partials are in `<component>/_partials/`. Import a partial and place it like a component:

```mdx
import PartialFeastInstall from "@site/hazelcast/_partials/integrate-feast-install.mdx";

<PartialFeastInstall/>
```

## Static assets

Images are co-located with the pages that use them, in an `images/` folder next to the page. Reference an image with a relative path, and give it alt text, for example:

```md
![Jet jobs write features to PostgreSQL, and Feast materializes them to Hazelcast for online queries.](./images/feast_batch.png)
```

Webpack resolves and content-hashes each image, and a missing image fails the build. `static/` is for the exceptions: files that must keep a fixed URL, such as `static/_redirects` and downloadable attachments.

## Submitting a change

Every change reaches the site through a pull request (PR) against the `main` branch:
1. Fork the repo, or create a branch if you have write access.
2. Make your change, following this guide. If the change applies to several versions, see [Changing content for several versions](#changing-content-for-several-versions).
3. Run `npm run build` and fix any errors it reports.
4. Open a PR that says what you changed and why.

Netlify builds a deploy preview of the site for every PR from a branch in this repo, and links it from the PR. Use the preview to check your change as readers will see it. PRs from forks do not get a deploy preview.

The docs team reviews every PR, and GitHub requests the review automatically. Add anyone else who needs to check the change, such as the engineers who own the feature.

To report a problem without fixing it, [open an issue](https://github.com/hazelcast/documentation/issues/new) that links to the page, or use the feedback button on the page.

## Writing style

These rules apply to every page, whether a person or an AI agent writes it.

### Readers

Write for these readers:
- Readers are developers and operators who use Hazelcast. Assume they know Java or another client language, Docker or Kubernetes where the page is about them, and general distributed-systems terms.
- Do not assume readers know Hazelcast concepts. Define a Hazelcast term the first time it appears on a page, or link to where it is defined.
- Write for AI readers as well as human ones. Either may arrive at a section without having read the one above it. Each section states its own subject instead of inheriting it.
- Give one concept one name throughout the site. Use the product names exactly: Platform, Management Center, CLC, Operator, Cloud.

### Accuracy

Every statement on a page must be true of the shipped product:
- Document what is built, not what is planned. Verify every statement about product behavior against the product code, a test that pins the behavior, or a live run. Do not document from a design document, a roadmap, or memory.
- Where the answer is not knowable from what you have, do not guess. Leave a comment for the owner in the form `{/* TODO: <question> */}`. An open question is correct, and a plausible guess is not.
- Do not promise future behavior or release dates. Do not use "currently" or "in the future". Each page describes its own version, and these words go out of date.
- State a limitation plainly. Readers use these pages to decide what to run in production.
- Release notes are generated at release time. Do not hand-edit them. Record a removal or a breaking change in the migration or upgrade guide instead.

### Voice

Write in a plain, direct, and formal voice:
- Use a neutral, direct register. Avoid contractions in new text, unless the expanded form reads badly.
- Do not rewrite a page's style as a side effect of an unrelated change.
- Write one idea per sentence. Keep to about fifteen words on average, and split anything over thirty.
- Use the present tense. Avoid "will": write "Hazelcast rejects the request", not "Hazelcast will reject the request".
- Address the reader as "you". Every sentence has a real agent: "The member closes the connection", not "the connection is closed". Avoid "we", "let's", and "our".
- Be precise. Name the thing and the action: "set the path with `--config`", not "point it somewhere else".
- Be concrete. No metaphors, and no "seamlessly", "robust", "powerful", "simply", "easily", "quickly", "effortlessly", or "very".
- Avoid the ", so" construction, which reads as either consequence or purpose. Split the sentence, or write "because" or "to".
- A value "increases" or "decreases". It never "rises", "grows", or "climbs".
- Do not sell the product or explain business context on a reference page.
- Do not use exclamation marks.

### Word choice

Use these forms:
- "Set up" is a verb, and "setup" is a noun. "Log in" is a verb, and "login" is a noun. Never write "set-up" or "log-in".
- Treat "data" as singular: "the data is replicated".
- Spell out numbers from zero to nine in prose: "three members". Use numerals for versions, units, and values: "5.7", "3 GB", "port 5701".
- Write a Hazelcast version as "version 5.7" or "5.7", not "v5.7". Write a third-party version the way that project does.
- Write "and", not "&".
- Hyphenate "server-side" and "client-side" when they come before a noun: "a client-side cache".
- Match the official capitalization of third-party names: npm, kubectl, macOS, Kafka.

### Headings

Structure pages with these headings:
- Use H2 for main sections and H3 for subsections. Use H4 only rarely, and never go below H4.
- Use sentence case: "Configure a cluster", not "Configure A Cluster". Do not end a heading with punctuation.
- Prefer imperative headings: "Configure a cluster", not "Cluster configuration".
- Never follow a heading directly with another heading. Open every section with at least one sentence saying what it covers.

### Lists and tables

Format lists and tables as follows:
- Introduce every table and list with a sentence ending in a colon. Put no blank line between the sentence and a list, and one blank line between the sentence and a table.
- Capitalize the first word of each list item and each table cell, unless it is a code identifier.
- Do not end list items with a period, unless an item in the list contains more than one sentence. In that case, end every item in the list with a period.
- Do not use bold for table column headings.
- Use `-` for bullet points.

### Formatting

Format text as follows:
- Write one line per paragraph. Do not hard-wrap Markdown or MDX files.
- Use the Oxford comma, always.
- Use US spelling: `behavior`, not `behaviour`.
- Use straight double quotes (`"`). Do not use single quotes or curly quotes for quotation.
- Put commands, file names, configuration keys, field names, and class names in backticks.
- Use bold for UI labels, such as buttons, tabs, and menus. Do not use bold for emphasis, do not combine bold and italic, and never bold a whole paragraph.
- Never open a sentence with a word that is always lowercase, such as a code item or a product name like npm. Keep the word's own case, and rewrite the sentence: "The `name` field", "Hazelcast sets `name`", or "Install the package with npm".
- Make each step in a procedure one action. Say what the reader should see when it succeeds, if it is not obvious.
- Write the product name "Management Center", not "MC". Write "CLC", not "clc", in prose.
- Give a code block a language, and a `title` when it represents a file.
- Do not use ellipses (`...`) in prose, horizontal rules (`---`), or decorative emoji.

### Links and images

Make links and images clear to every reader:
- Use descriptive link text, preferably the target page's title. Never use "click here", and never start a sentence with a link.
- Never paste a bare URL as a link: write `[Docker Hub](https://hub.docker.com)`, not `https://hub.docker.com`. When the reader needs the address itself, such as a local URL to open, put it in backticks: `http://localhost:8080`.
- Give every image alt text that gives the information the image carries, not its title. For a diagram, describe the flow in one sentence: "Jet jobs write features to PostgreSQL, and Feast materializes them to Hazelcast for online queries", not "Feast batch workflow".
- Give image files descriptive names: `wan-replication-topology.png`, not `image1.png`.

### Admonitions

Use admonitions sparingly, and choose the type by what the reader must do:
- `:::tip` for a recommended action or a shortcut
- `:::note` for information that is useful but not essential
- `:::important` for something the reader must know or do to succeed
- `:::warning` for a risk of unexpected behavior, data loss, a security problem, or an outage

Put a blank line after the opening line and before the closing `:::`.

### One explanation per fact

Explain each fact in one place:
- Explain a fact, meaning the mechanism and the reason it behaves that way, on one page only.
- On every other page that needs the fact, say what that page's reader needs and link to the explanation. Do not restate it.
- A feature can still belong on several pages. For example, a setting can appear in a configuration guide, a reference, and a tutorial.
