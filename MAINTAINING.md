# Maintaining the Hazelcast documentation site

This guide is for the Hazelcast docs team. It covers releases, deployment, external content, and the third-party services the site loads.

## Releasing a version

When a product is released, its docs need new version numbers, and a major or minor release also needs a new version of the docs. The script `.github/scripts/version-update` makes these changes for every versioned product.

Run `npm run test:version-update` if you change the script.

### Run the version update script

There are three ways to run the script:
- **Platform release pipeline**: the Hazelcast release pipeline calls `package.yml`, which opens a draft PR, and then `promote.yml`, which marks the PR ready, waits for its checks, and merges it. Use one of the other two ways for Platform only if the pipeline cannot run.
- **Version update workflow**: run `version-update.yml` from the Actions tab for any product. It opens a PR. Tick **merge** to merge the PR once its checks pass. A product's own release workflow can start it with the GitHub CLI, e.g. `gh workflow run version-update.yml -R hazelcast/documentation -f component=clc -f version=5.5.2`.
- **Locally**: run the script from the repo root on an up-to-date `main`, then open the PR yourself. Add `--dry-run` to list the changes without making them.

Re-running a workflow for the same release closes the earlier PR and opens a new one. If the script fails partway through, it restores every file it changed.

### Commands

The command for each product:

| Product           | Patch release                                                       | Major or minor release                                                                |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Platform          | `node .github/scripts/version-update hazelcast 5.7.2`               | `node .github/scripts/version-update hazelcast 6.0.0 --next 6.1.0-SNAPSHOT`           |
| Management Center | `node .github/scripts/version-update management-center 5.11.2`      | `node .github/scripts/version-update management-center 5.12.0 --next 5.13.0-SNAPSHOT` |
| Operator          | `node .github/scripts/version-update operator 5.19.1 --next 5.20.0` | `node .github/scripts/version-update operator 5.20.0 --next 5.21.0`                   |
| CLC               | `node .github/scripts/version-update clc 5.5.2`                     | `node .github/scripts/version-update clc 5.6.0`                                       |

The options:
- `--next`: for a Platform or Management Center major or minor release, the development version that `main` moves to, e.g. `6.1.0-SNAPSHOT`. For Operator, the next planned release, e.g. `5.21.0`, which every Operator release needs. In the Version update workflow, these are the `next-snapshot` and `next-release` inputs.
- `--hazelcast` and `--mc`: Operator only, on any release. The newest Platform and Management Center versions that the release supports, e.g. `--hazelcast 5.7.1 --mc 5.11.1`. Leave them out to keep the current values. In the workflow, these are the `supported-hazelcast` and `supported-mc` inputs.

### What the script changes

A patch release updates the version numbers of the version it belongs to, in `src/variables.ts`. For Management Center, a patch release also sets `mc-repo-swagger-branch` and adds a `release-notes/X-Y-Z` redirect to the release notes page, which the downloads page on `hazelcast.com` links to. If the version is not in the repo, for example a patch to a line that has been retired, the script skips it instead of failing.

A major or minor release makes a new version of the docs:
- The product's `main` pages are copied to `<product>_versioned_docs/version-X.Y`, together with its variables, its page redirects in `src/redirects.ts`, and its files in `static/<product>/`. The new version is added to `<product>_versions.json`.
- Links in the copy that pointed at `main`'s version now point at the new version.
- For Platform and Management Center, `main` moves to the next snapshot. The script renames `main`'s URL segment in `src/currentVersions.json`, updates `main`'s variables, and points links in `main` at the new segment.
- The `latest` rule in `static/_redirects` points at the new version. For Platform and Management Center, the `latest-dev` rule points at the new snapshot.

Each product has its own differences:
- **Platform and Management Center**: a release of one also updates the other's "latest supported" value, `page-latest-supported-mc` or `page-latest-supported-hazelcast`.
- **Operator**: a release is a new version when its X.Y line does not exist yet, whatever its patch number. A release of an existing line updates that version's variables. `main` is always `latest-snapshot`, and the script never renames it. Every release sets `main`'s `operator-chart-version` from `--next`.
- **CLC**: `main` is always the newest release, not a snapshot. Every CLC release, including a patch release, copies `main` to a version named after the outgoing release, and renames `main` to the new release. Merge the new release's content into `main` after the version update. The outgoing content then stays in the outgoing version.

### What the script refuses

The script stops without changing anything when:
- The version is a beta, or is not `X.Y.Z`.
- A Platform or Management Center major or minor release does not match `main`'s snapshot version, or has already been released. For example, if `main` is `5.8-snapshot`, the only major or minor release it accepts is 5.8.0.
- A CLC release is not newer than `main`. For example, if `main` is 5.5.1, then 5.5.2 and 5.6.0 are accepted, but 5.5.1 and 5.5.0 are refused.

## Deployment

The site is hosted on Netlify. Netlify reads its build settings from `netlify.toml`:
- It runs `npm run build` and publishes the `build/` folder.
- It serves `static/_redirects`, which is copied into `build/`, as the site's redirect rules.
- It sets a cross-origin header on `/api/*`, because the Hazelcast Cloud console fetches `/api/cloud.json` from another domain.

Netlify builds a deploy preview for every PR from a branch in this repo, and links it from the PR. PRs from forks do not get a preview.

The build fetches the OpenAPI specs from private repos, so the Netlify build needs a GitHub token. See [GitHub token](#github-token).

TODO: document how a merge to `main` reaches production, where the Netlify site and its environment variables are managed, and who has access.

The page redirects in `src/redirects` are processed by Docusaurus during the build, and are treated as instant meta refreshes.

## CI workflows

These GitHub Actions workflows run in this repo:

| Workflow                                           | Runs                                                                                         | What it does                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `maven-pr-builder.yaml`                            | On PRs that change `hazelcast/examples/`, `pom.xml`, or `src/variables.ts`, and every Sunday | Compiles the Java examples against the Platform version and minimum Java version of `main`, from `src/variables.ts`                |
| `tests.yml`                                        | On every PR                                                                                  | Runs `npm test`: the unit tests for the plugins, remark plugins, and scripts                                                       |
| `validate-docs-on-schedule.yml`                    | Every Monday, or by hand                                                                     | Builds the site and checks every external link. A link that returns 404 fails the run, and the run summary lists where it appears. |
| `version-update.yml`, `package.yml`, `promote.yml` | By hand, or from a release pipeline                                                          | See [Releasing a version](#releasing-a-version)                                                                                    |

The workflows use the organization secret `GH_TOKEN`. The scheduled runs post failures to the `#docs-notifications` Slack channel through the `SLACK_WEBHOOK_DOCS` secret.

## Search

Site search uses Algolia DocSearch. The site's side of it is `themeConfig.algolia` in `docusaurus.config.ts`, which sets the application, the search-only API key, and the index. The crawler that fills the index is configured in the Algolia dashboard, not in this repo.

The crawler indexes only the latest release of each product. After a major or minor release, update the crawler's URL patterns to the new version.

`contextualSearch` is off on purpose. With it on, a search on an older version returns no results, because older versions are not indexed.

TODO: replace the test index name in `docusaurus.config.ts` with the production index, and remove the temporary `algolia-site-verification` tag from `headTags`, before cutover. Document who has access to the Algolia dashboard.

## Build outputs used by other systems

The build writes these files for other systems to read. Do not change their shape without checking with the consumer:

| File              | Written by                    | Read by                                                                                                                            |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/api/cloud.json` | `plugins/cloud-console-index` | The Hazelcast Cloud console, for its in-product help links. Built from the `cloud_*` frontmatter keys on Cloud and tutorial pages. |
| `/llms.txt`       | `plugins/llms-txt`            | AI tools. It lists the pages of the latest release of each product.                                                                |

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

#### Update a pinned code example

Each entry in `tutorials/examples.json` and `operator/examples.json` pins one file by commit and content hash. To move an example to a newer version of its source file:
1. Find the commit you want in the source repo.
2. Set the entry's `sha` to that commit.
3. Set the entry's `sha256` to the hash of the file at that commit:

   ```bash
   curl -sL https://raw.githubusercontent.com/<repo>/<sha>/<path> | shasum -a 256
   ```

4. Run `npm run start` or `npm run build`. The build fails if the hash does not match.

TODO: add a script that updates the pins, to replace these manual steps once the migration tooling is removed.

### Fetched from Wordpress

The reader's browser fetches these on page load, not at build time. The build does not depend on them:

| Content             | Loaded by                    | Source                                                                                                                                       |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy policy text | `src/pages/privacy.tsx`      | hazelcast.com WordPress API. The endpoint only allows requests from docs.hazelcast.com. The page is empty on the dev server and on previews. |
| Promo banner        | `src/components/PromoBanner` | hazelcast.com WordPress API. Usually returns no banner, which is normal.                                                                     |

## Cookies and third-party services

The site uses Enzuzo for privacy management. The site loads these third-party services in the reader's browser:

| Service            | What it does                                                | Configured in                                   | Cookies and storage                                                                                                                              |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google Tag Manager | Loads Google Analytics and the Enzuzo cookie consent banner | `docusaurus.config.ts`                          | Set by the container's tags. Enzuzo writes `cookies-analytics=true` when the reader accepts analytics cookies.                                   |
| Algolia            | Site search                                                 | `themeConfig.algolia` in `docusaurus.config.ts` | No cookies. Recent searches are kept in the reader's local storage.                                                                              |
| Kapa               | The **Ask AI** assistant                                    | `src/clientModules/kapa.ts`                     | Sets `kapa_web_id` only if the reader has accepted analytics cookies, and deletes it if they withdraw consent.                                   |
| PushFeedback       | The page feedback form                                      | `src/components/FeedbackButton`                 | None. The widget is bundled with the site and contacts PushFeedback only when the reader submits feedback. It does not ask for an email address. |

Google Tag Manager runs only in production builds. There is no Enzuzo or Google Analytics code in this repo, because the Tag Manager container loads both. The Tag Manager container is also where analytics events are defined. The site pushes events to it, for example the Kapa usage events in `src/clientModules/kapaAnalytics.ts`.

To see which cookies are currently enabled, find the Enzuzo configuration panel link in the Privacy Policy (linked from the footer).

Before you add a service that runs in the reader's browser, check whether it sets cookies or stores an identifier, and make it wait for consent if it does. Prefer a bundled npm package to a script loaded from a CDN. Add the service to this table.

## Previous documentation repos

Before this repo, the site was built with Antora from separate repos. The content was converted, but its git history was not carried over. For the history of a page before the migration, or for older issues and pull requests, see:

| Repo                                                                                                        | Content                                                   |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [hazelcast/hazelcast-docs](https://github.com/hazelcast/hazelcast-docs)                                     | Site configuration, landing page, and the Antora playbook |
| [hazelcast/hazelcast-docs-ui](https://github.com/hazelcast/hazelcast-docs-ui)                               | Site theme                                                |
| [hazelcast/hz-docs](https://github.com/hazelcast/hz-docs)                                                   | Platform                                                  |
| [hazelcast/management-center-docs](https://github.com/hazelcast/management-center-docs)                     | Management Center                                         |
| [hazelcast/hazelcast-platform-operator-docs](https://github.com/hazelcast/hazelcast-platform-operator-docs) | Operator                                                  |
| [hazelcast/clc-docs](https://github.com/hazelcast/clc-docs)                                                 | CLC                                                       |
| [hazelcast/cloud-docs](https://github.com/hazelcast/cloud-docs)                                             | Cloud                                                     |
| `hazelcast-guides/*`                                                                                        | Tutorials, one repo per tutorial                          |

In the versioned repos, each released version has its own branch, e.g. `v/5.7` in `hz-docs`.

TODO: state that the repos are archived, once they are.

## Migration tooling

The `migration/` folder holds disposable tooling used to convert the Antora content to Docusaurus. It has its own `package.json`, and normal site work does not need it. See `migration/README.md` before using it.
