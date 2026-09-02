# Migration tooling

Disposable tooling for migrating Hazelcast's Antora docs to this Docusaurus site. Walled off from the site: it has its **own** `package.json` (Antora/asciidoctor deps) so nothing leaks into the root build. Delete the whole `migration/` dir (`git rm -r migration/`) once the migration is done — keep `manifest.json` + `lockfile.json` in git history as the audit record.

## Mental model

Three zones, left to right, that never run as part of each other:

```
external Antora source repos  ->  migration/ (this dir)  ->  Docusaurus site (repo root)
     (frozen bare mirrors)          manifest + convert + test        npm run build
```

Everything here runs offline with `runtime.fetch: false`. The migrated repos are read from **bare mirror clones under `.sources/`** (gitignored) — these `github.com/hazelcast/*` repos (note the repo name ≠ the component/URL name in a few cases). The resolution-only guide repos are pulled from remote instead (see below).

| Mirror (`.sources/*.git`) | Provides component(s) | Branches | Role |
|---|---|---|---|
| `hz-docs.git` | `hazelcast` (Platform) | `main`, `v/*` | migrated |
| `management-center-docs.git` | `management-center` | `main`, `v/*` | migrated |
| `clc-docs.git` | `clc` | `v/*` | migrated |
| `hazelcast-platform-operator-docs.git` | `operator` | `main`, `v/*` | migrated |
| `cloud-docs.git` | `cloud` (+ `tutorials`) | `main` | migrated (+ resolution-only) |
| `hazelcast-cloud-maven-plugin.git` | `cloud` (the `maven-plugin-hazelcast` page) | `main` | migrated |
| `jdbc-driver-docs.git` | `jdbc-driver` | `main` | migrated |
| `hazelcast-docs.git` | `home`, `privacy` (+ `tutorials`) | `main` | migrated (+ resolution-only) |
| `imdg-docs.git` | `imdg` | `v/*` | resolution-only |

**Migrated** components are converted and their pages appear in the golden snapshot. **Resolution-only** components (`imdg`, `tutorials`) are built *only* so cross-component xrefs from the migrated set resolve to the correct `/imdg/…` and `/tutorials/…` URLs exactly as production does — they're in the content catalog and the manifest, but their pages are **not** converted or emitted to the golden tree (the snapshot builder emits an allowlist of migrated components; everything else is resolution-only). `imdg` has 233 inbound xrefs from the migrated set, `tutorials` 19.

The `tutorials` component is assembled from `hazelcast-docs/tutorials` + `cloud-docs/tutorials` **plus the 56 `hazelcast-guides/*` repos** (each declares `name: tutorials`), which host the actually-referenced tutorial pages. Those 56 are pulled from **remote** (`https://github.com/hazelcast-guides/…`), not mirrored: since nobody edits them, `fetch: false` clones each once into `.cache` on the first run and freezes it — no working-clone-contamination risk (we don't edit them) and no drift risk (they don't change). Their SHAs are recorded in the lockfile.

The mirrors are migration-owned and **frozen** — they don't read your working clones, and they don't move until you deliberately update them, so the pinned SHAs stay fixed no matter what happens on any branch (local or origin). That's what makes the baseline reproducible. Populate them once, from `migration/`:

```
git clone --mirror https://github.com/hazelcast/<repo>.git .sources/<repo>.git
```

Out of scope, staying on Antora for now: the external `hazelcast-code-samples` repo and the ~57 `hazelcast-guides/*` repos (each its own Antora component). Not to be confused with hz-docs's *internal* `examples/` tree — the Maven-validated tagged code snippets pulled in via `include::example$` — which is part of hz-docs and migrates with it.

## What produces what

| Script | Produces | Notes |
|---|---|---|
| `npm run index-pass` | `build/manifest/manifest.json`, `build/manifest/lockfile.json` | Read-only. Aggregate + classify only, **no rendering**. The link/attribute resolution table + the SHA pin. Both committed. |
| `npm run fidelity:snapshot` | `build/golden/pages/**.html` + `snapshot-meta.json` | The expensive one: full document render = the "before" image. Gitignored (regenerable). |

**manifest.json** — every resource id → its exact current URL, plus per-version resolved attributes. The converter resolves links against this, so migrated links point at final URLs even before the target page exists.

**lockfile.json** — the resolved git SHA of every source. A **deliberate point-in-time pin**, not a live-latest tracker. Frozen SHAs are fine by design; upstream changes are reconciled in later, never chased.

**golden snapshot** — rendered HTML at the pinned baseline. Keyed to the lockfile: a fidelity run hard-stops if the pin it was built from no longer matches. Regenerate deliberately, never per-check.

## Running the gates

Four gates must all pass before a converted page is trusted. They're described in detail below (fidelity harness, reference checker, construct-coverage gate, orphan gate); this is the operational summary.

The fidelity, refs and constructs gates **read the converted output from the root Docusaurus build**, so build the site first. The orphan gate is the exception: it reads the **Antora sources directly** (orphan-ness is a source-side structural fact, independent of what has been converted yet) and needs no build. Run the gates from `migration/`:

```
(cd .. && npm run build)   # produces the converted "after" the first three gates read
npm run census             # poisoned render the refs gate reads its expectations from (~1 min)
npm run check              # runs all four gates, then a pass/fail summary
```

Like the golden snapshot, the census render is a **build input**, not part of `check`: rebuild it when the pin changes (the refs gate hard-stops on a stale one, so it cannot silently compare against another revision's expectations).

`npm run check` is the one command to remember. It runs **all four** gates regardless of individual outcome (no fail-fast — a failure in one no longer hides the others), prints a one-line summary, and exits non-zero if any gate failed. Scope the whole set the same way the gates scope individually — `npm run check -- --component cloud` forwards the flag to all four (the `--` separator is required, else npm swallows it). Individually:

| Script | Gate | Also needs |
|---|---|---|
| `npm run check:fidelity` | rendered golden vs rendered Docusaurus (3 layers) | the golden snapshot (`npm run fidelity:snapshot`) |
| `npm run check:refs` | no-baking: every attribute occurrence the source resolved is still a reference | the census render (`npm run census`) + golden + manifest |
| `npm run check:constructs` | construct-coverage allowlist (deny-by-default) | `.sources` mirrors + manifest |
| `npm run check:orphans` | published pages in no navigation tree (deny-by-default) | `.sources` mirrors |

Each takes `--component X` to scope to a subset (fidelity/refs also take `--id /url`; orphans also takes `--include-resolution-only`), `--json` for machine output, and writes a full report under `build/`. All exit non-zero on findings.

### Accepted findings

Some discrepancies are real, understood, and not going to change. `refcheck/accepted.json` and `fidelity/accepted.json` (mechanism in `lib/accepted.js`) let you record one so its gate goes green **while it is still printed on every run** and written to the gate's JSON report. The point is to stop it blocking, not to hide it — a permanent failure teaches the reader to skim past the failure section, which is how a genuine new finding gets missed.

Four properties keep an accept-list from becoming a way to make a gate lie:

- **Occurrence-exact keys.** A key pins the finding's numbers, not just its page: accepting `{hazelcast-cloud} 12->11` does not accept `12->10`. A second defect on an already-accepted page changes the key and fails. Keys are printed by the gates, so an entry can be copied from their output.
- **Deny by default.** Only an exact key match clears. No patterns, prefixes or wildcards.
- **A reason is required.** Each entry needs a `disposition` — `wont-fix`, `upstream`, `harness-limit`, `deferred` — and a non-empty `note`. A malformed entry fails the gate.
- **Stale entries fail.** If an accepted finding stops occurring, the file now claims a defect that is fixed; pruning it is a one-line edit and failing is what makes sure that happens. Scope-aware, so `--component cloud` does not call operator's entries stale. (Deliberately stricter than orphancheck's allowlist, which only warns.)

Not everything is acceptable. refcheck's `unknownContexts` and `guardFailures`, and fidelity's page-level `error`, can never be accepted: each means the gate could not judge the page at all, so silencing one would silence everything behind it.

Reach for `harness-limit` only after checking the **rendered** output — a comparator blind spot is a harness bug, not a discrepancy. The admonition-title strip fixed on 2026-08-17 was one: Layer 1 dropped the whole `admonitionHeading` element on the Docusaurus side, so every `:::warning[Custom title]` reported its title as missing text even though the built page rendered it correctly.

Supporting scripts, **not** part of `check`:

- `npm run selftest` — unit tests for the pure logic the gates and converter depend on (needs no golden/build): the shared layout config (`lib/layout.js`); the converter's MDX escapers, link classifiers, partial-factoring, and nav→sidebar plan; the fidelity harness's Layer 1/2/3, golden de-instrumentation, manifest URL resolver, snapshot-pin key, and page pairing; the reference-checker matchers; the construct detectors; and the orphan gate's reachability logic (xref/include extraction, logical-page key, orphan classification, allowlist schema + deny-by-default). Like `check`, it runs **all** suites regardless of individual outcome and exits non-zero if any failed. Run after editing any of them. Individually: `selftest:layout`, `selftest:converter`, `check:fidelity:selftest`, `check:refs:selftest`, `check:constructs:selftest`, `check:orphans:selftest`.
- `npm run diagnose:layer3` — a human-facing calibration report (no pass/fail): histograms Layer 3's unresolved links over the golden so you can tell resolver bugs from fidelity-neutral pre-existing broken links. Needs the golden snapshot.

There is no CI or git hook yet — running the gates is manual and on-demand (per the direct-to-main strategy). Wiring `npm run check` into CI is the intended durable backstop, still to be built.

## Fidelity harness (the correctness guarantee)

The published content must not change during the migration, so automated fidelity checking is the correctness guarantee. Three layers, run locally on demand and diffed against the golden snapshot, keyed to the lockfile so upstream drift ≠ conversion error:

1. **Text diff** — normalized main-content (strip chrome, collapse whitespace). Primary gate; every diff is a human-review flag.
2. **Structural inventory** — per-page counts (headings, code blocks, admonitions, tables, images, links). Catches what normalization hides.
3. **Link/anchor integrity** — every internal link resolves against the manifest. Cheapest; needs no snapshot.

The fidelity harness compares **rendered golden vs rendered Docusaurus**, so it cannot see a *baked-in reference* — an attribute, partial, or include resolved to a literal instead of kept as a reference renders identically to the golden. That is a separate, SOURCE-side gate:

### Attribute marking (`antora-extension/mark-attributes.js`)

Some attributes cannot be recovered from the rendered golden by value: `hazelcast-cloud` resolves to `"Cloud"`, indistinguishable from a page's literal "Confluent Cloud". So the golden is instrumented, inline, the way `mark-partials` instruments blocks: before render, each `{name}` reference (for the attributes in `MARKED_ATTRS`, `lib/layout.js`) is wrapped so its exact position is marked, and after render each mark becomes `<span class="hz-attr-name">value</span>`. The converter turns those spans into `<Variable name="name"/>` (prose / table cell / heading), a `{name}` token in a link-mode `<Variable>`'s `text`, or a raw `<a>` when the reference sits in a markdown-link label.

Two wrap forms, by context:

- **Flow text and `:description:`** use plain-text sentinel characters, post-processed into spans (`spanify`). Plain sentinels — not AsciiDoc role markup or raw HTML — because a reference often reaches the body indirectly (`:description:` carries `{hazelcast-cloud}` and is rendered by `{description}`), and Asciidoctor expands that nested attribute after the formatting passes, escaping anything but inert text.
- **Section headings** (`== …` and deeper) use an AsciiDoc **role span**: Asciidoctor derives a heading's anchor id from its text with inline roles stripped, so the golden id stays clean (a sentinel's characters would leak into the slug). The converter emits the `<Variable>` in the heading and **force-pins** the golden id (`{/* #id */}`), because Docusaurus derives the slug from the heading text and cannot read it through the component. Verified in a real build: `## <Variable name="hazelcast-cloud"/> Standard` keeps `id="cloud-standard"`.

Left baked (correctly): the document **title** (`= …` → frontmatter `title:`), image `alt`, and an unused `:description:`. `readGolden` strips the spans so the fidelity baseline is byte-identical (verified: strip(marked) === clean across the cloud corpus). On by default in the snapshot builder; `--no-mark-attributes` renders bare.

## Reference checker (the no-baking gate)

`npm run check:refs [-- --component cloud|operator|clc] [-- --id /url]` — asserts that every attribute occurrence the source resolved is still a **reference** in the converted MDX, not a baked literal. Needs a census render (`npm run census`) as well as the golden. Non-zero exit on any finding; report at `build/refcheck-report.json`. `npm run check:refs:selftest` unit-tests the pure logic.

The gate exists because fidelity is blind here by construction: it compares rendered golden to rendered Docusaurus, and a baked value renders identically to the reference it replaced.

### How the expectation is derived: the census render

`npm run census` renders the whole corpus a second time with every **content** attribute's value replaced by a unique inert token (`HZREF0042X`), into `build/census/` — a throwaway tree, never a golden. Scanning that HTML answers, per page and **per occurrence**, which attributes flowed where and into what position: Asciidoctor already expanded the includes, sliced the tags, evaluated the `ifdef`s and substituted the nested `{description}`, so there is no source parsing to approximate any of it.

It carries every render pass that **changes** the output and drops the ones that only add instrumentation, because the unmask guard below compares it to the golden: `mark-partials` and `mark-attributes` are off (`readGolden` strips their sentinels off the golden side, so a bare census matches), `normalize-monospace` is on, and `mark-conditionals` is on — that pass is *mostly* instrumentation, but a unit whose markability is `promotes-title` deliberately changes the render, so an unmarked census cannot reproduce the golden there. Its sentinels are strippable, and refcheck reads the census through `stripConditionalSentinels`.

Two properties make it trustworthy:

- **Shape-preserving poisoning** (`antora-extension/poison-attributes.js`). Attribute substitution runs *before* the macro pass, so a value that is a whole URL is the only reason `{page-cloud-console}[text]` becomes a link. A URL value therefore poisons to a URL (`https://HZREF0042X.invalid/`), a `www.` value to a `www.` host. Reserved names (`lib/reserved-attrs.js` — Asciidoctor/Antora machinery: `idprefix`, `env`, `page-excluded-versions`, …), flags and empty values are left real. Membership in that list is decided by the Asciidoctor/Antora registries, not by what breaks; **anything not listed is poisoned**, so a new content attribute is checked by default.
- **The unmask guard.** Putting the real values back must reproduce the golden byte-for-byte. The only permitted difference is a *derived anchor id* (a token in a heading is slugged into the id, which a case-sensitive unmask cannot restore); a page differing anywhere else fails the gate, because poisoning changed the render itself and the expectations read off it can't be believed.

### What is checked

- **Attributes** — for each page, the census's preserved-occurrence count per attribute must **equal** the reference count in the converted MDX closure: the page body, plus each imported partial and example file counted **once per use** (a partial used twice contributes twice, matching Antora inlining it twice). A reference is `<Variable name="…"/>`, a `{name}` token in a link-mode `<Variable>` or a `vars` fence, or a `{name}` in an imported example file (substituted at build by `plugins/example-attributes/attributes-loader.js`). A `{name}` in a fence *without* `vars` is a literal and does not count.
  - fewer than expected ⇒ a **baked** reference, including partial baking (5 occurrences, 4 baked, 1 left);
  - more than expected ⇒ **over-variableised**: the converter turned a coincidental literal into a `<Variable>`, which will follow the wrong value when the attribute changes. Nothing else catches this, and after cutover there is no golden left to notice it.
  - **Snapshot conditionals are compared half for half.** A spliced page carries BOTH branches of an `ifdef::snapshot`/`ifndef::snapshot` pair in every version's MDX (so a `docs:version` cut carries both, and `<IfSnapshot>`/`<IfNotSnapshot>` choose at build time), while the census is one version's render and can only account for the half that version resolved. The census names that half — `mark-conditionals`' sentinels sit *inside* each branch, so they are present exactly when it is — and the counter drops the other branch's component before counting. Without this, a page whose two halves both reference an attribute reads as over-variableised (management-center's `install.adoc`: expected 4, found 6).
- **Examples** — a page that pulls `example$` includes must import at least one example file rather than baking them all as literal fences. Still a floor, not an accounting: the converter matches examples by content and dedupes identical ones, so per-include matching would false-positive on every dedup. Extending the partial-boundary marker to the `example` family is what would make this exact.

- **Frontmatter** — a `{name}` token in a page's YAML frontmatter is reported as **inert**: nothing interpolates frontmatter, so it reaches the reader as literal braces (in a sidebar label, say). Attributes in nav labels are therefore **baked** at conversion, as Antora bakes them when it renders the nav — so this finding means the baking was missed, not that a reference was lost.

Nothing is ever matched on an attribute's real **value**, so a page that merely contains the literal `5.7.0` (operator's CRD default-values table does) cannot register as a reference. That is what let the converter's old `auditStillBaked` warning be deleted: it string-matched values, warned on that table on every run, and so trained the reader to ignore the category.

### Findings mean defects

Positions where a reference *cannot* be preserved are classified by `refcheck/lib/bake-contexts.js` — a closed table keyed by **position**, not by name, so exempting a heading's anchor id does not blind the gate to a baked occurrence of the same attribute in prose on the same page. They are reported as a tally ("N occurrences correctly baked"), never as failures. An **unrecognised** position has no disposition and fails the gate: classify it (preserve, or bake with a reason) rather than let a new rendering context become an unchecked hole.

So a clean conversion produces an empty gate, and every line of output is something to fix.

Known false negatives, both narrow and deliberate: a bare `xref:target.adoc[]` renders the target's **title** as its link text, and Antora resolves page titles during classification — before poisoning — so a reference reaching a page only through a derived link label carries the real value and is not counted (consistent with titles baking into frontmatter). And cross-component `templates:` example includes still resolve outside the checked components.

Shares `lib/layout.js` (source repo/branch + version/path config) with the converter so the two resolve sources and output paths identically.

## Orphan gate (the navigation-reachability gate)

`npm run check:orphans [-- --component X] [-- --include-resolution-only]` — the other gates all reason about a page the migration already tracks; none can tell you a page *exists that nothing points at*. This gate finds those. It aggregates the whole source corpus (every component, **every branch** — via the shared `lib/catalog.js`, the same aggregate+classify `index-pass` uses), walks every navigation tree and every page's xrefs **through includes**, and reports each published page reachable from neither. Non-zero exit on any un-triaged orphan (or a malformed allowlist); report at `build/orphancheck-report.json`. `npm run check:orphans:selftest` unit-tests the pure logic.

An **orphan** is a published page in no navigation tree. It splits by whether anything links to it:

- **unreachable** — not in nav *and* no inbound xref. Dead unless you already know the URL (external inbound links aside — those the corpus can't see). The two cloud pages `teams-and-users` and `jdbc-sample-client` are the canonical pair.
- **referenced** — not in nav *but* reachable via an xref from some page. Dropping one of these without a redirect breaks an in-corpus link, which `refcheck` would then flag — so these need a redirect or the referrers fixed.

Resolution-only components (`imdg`, `tutorials`) are excluded by default (they aren't emitted as pages, so their orphans are moot); `--include-resolution-only` shows them.

The allowlist (`orphancheck/allowlist.json`) is **deny-by-default**, like `constructcheck`, and ships **empty** so every orphan is flagged until triaged. Keys are the **logical page** — `{component}[:{module}]/{relative-without-.adoc}`, e.g. `cloud:teams-and-users` — so **one entry covers a page across every branch it is orphaned in**. Each entry records a **disposition**, which is where the redirect-vs-404 decision lives and is auditable:

| disposition | meaning |
|---|---|
| `keep-in-nav` | will be added to the nav during migration, so it stops being an orphan |
| `keep-referenced` | intentionally not in nav; reachable only via inline xref |
| `redirect` | stop publishing the page and redirect its URL to `to` (required; **relative to the component/version**, e.g. `/maintain-cluster/rest-api`, since one key covers every version) |
| `drop-404` | drop the page; a 404 is acceptable — nothing external should rely on it |

The gate validates that schema (bad disposition, or a `redirect` with no `to`, fails the run) so the decision is captured honestly rather than living in someone's head. The dispositions are **instructions to the build**, not just notes, read through `lib/dispositions.js` so the gate and the converter cannot drift apart:

- `drop-404` and `redirect` both **withhold the page** — no `.mdx` is emitted, and all three other gates drop it from scope rather than counting it as not-yet-converted. For `redirect` the withholding is the point: a real page at the URL would take precedence over the redirect.
- `redirect` additionally emits a `{from, to}` into `src/redirects.ts` (alongside the page-alias redirects), resolved **per version** against the page's own URL base so a version never redirects across a version boundary. A `to` naming a page that is not published — a typo, or another withheld page — **fails the run** rather than shipping a redirect into a 404.
- Inbound xrefs to a redirected page are **retargeted at conversion time** to point straight at the target, so internal navigation does not take a redirect hop. (`onBrokenLinks` is `warn`, so without this those links would silently ship broken.) The client redirect then does the job only it can: keeping the old URL alive for bookmarks and links from outside the site.
- `keep-in-nav` injects the page into the nav at `nav.after` (see `converter/lib/nav.js` `injectNavEntries`). An allow key matching no current orphan is reported as **stale** (surface-only, non-fatal — a page ceasing to be an orphan is success). Shares `lib/catalog.js` with `index-pass` so the two never disagree about which pages/xrefs exist.

Baseline at wire-up: **73 logical orphan pages** across the migrated set (50 unreachable + 23 referenced; 237 version-instances) — clc 8, cloud 2, hazelcast 58, management-center 4, operator 1. GA shows these are low-traffic (single-digit 2026 views on the ones sampled), which makes `drop-404` defensible for most; reserve redirects for pages with real external traffic or (for referenced orphans) live internal referrers.

## Gotchas worth remembering

- The pin is enforced by the mirrors **not moving**, not by the lockfile: Antora builds branch *tips*, so `lockfile.json` only *records* the SHAs — freezing them means never updating the mirror. `runtime.fetch: false` guarantees a build never moves a ref.
- To advance the baseline (fold in upstream changes): `git -C .sources/<repo>.git remote update --prune`, re-run the index pass, regenerate the golden snapshot — together, deliberately. The snapshot's pin check keeps them in step.
- Runs are offline (mirrors are local); only populating/advancing a mirror needs network.
- Per-version conditionals (e.g. `ifdef::snapshot`) resolve correctly because each page renders with its **own** component-version AsciiDoc config.
- The manifest deliberately excludes partials/examples (no URL) — the include graph is separate, unbuilt work.
- `onBrokenLinks` must be `'warn'` during migration (links point at not-yet-migrated pages); flip to `'throw'` at cutover.

## Status

Built: index pass, golden-snapshot builder (with `--component` scoping for smoke tests), all four gates (fidelity harness, reference checker, construct-coverage gate, orphan gate) and the converter. Not yet built: CI wiring for `npm run check`, orphan triage (populating `orphancheck/allowlist.json` + the redirect-generation step that reads its dispositions), the include graph, Swagger handling.
