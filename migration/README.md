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

Three gates must all pass before a converted page is trusted. They're described in detail below (fidelity harness, reference checker, construct-coverage gate); this is the operational summary.

**All three read the converted output from the root Docusaurus build**, so build the site first, then run the gates from `migration/`:

```
(cd .. && npm run build)   # produces the converted "after" the gates read
npm run check              # runs all three gates, fails fast on the first
```

`npm run check` is the one command to remember. Individually:

| Script | Gate | Also needs |
|---|---|---|
| `npm run check:fidelity` | rendered golden vs rendered Docusaurus (3 layers) | the golden snapshot (`npm run fidelity:snapshot`) |
| `npm run check:refs` | no-baking: every source `{attr}`/`example$` survives as a reference | `.sources` mirrors + manifest |
| `npm run check:constructs` | construct-coverage allowlist (deny-by-default) | `.sources` mirrors + manifest |

Each takes `--component X` (and fidelity/refs take `--id /url`) to scope to a smoke subset, `--json` for machine output, and writes a full report under `build/`. All exit non-zero on findings.

Supporting scripts, **not** part of `check`:

- `npm run selftest` — unit tests for the pure logic the gates and converter depend on (needs no golden/build): the shared layout config (`lib/layout.js`); the converter's MDX escapers, link classifiers, partial-factoring, and nav→sidebar plan; the fidelity harness's Layer 1/2/3, golden de-instrumentation, manifest URL resolver, snapshot-pin key, and page pairing; the reference-checker matchers; and the construct detectors. Run after editing any of them. Individually: `selftest:layout`, `selftest:converter`, `check:fidelity:selftest`, `check:refs:selftest`, `check:constructs:selftest`.
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

`npm run check:refs [-- --component cloud|operator] [-- --id /url]` — for every migrated page it reads the AsciiDoc source *through its includes* (from the frozen mirror) and asserts the converted MDX still carries a reference for everything the source referenced. Non-zero exit on any finding; report at `build/refcheck-report.json`. `npm run check:refs:selftest` unit-tests the matchers.

- **Attributes** — every `{name}` the source resolves in a **preservable context** must survive as a reference in the output: a `<Variable name="…"/>` (prose), a `{name}` token (link href/text or a `vars` code fence), or a `{name}` in an imported byte-faithful example file. A miss is a baked attribute. **All** referenced attributes are checked (not a hand-list); pure Asciidoctor/Antora machinery is filtered by `refcheck/lib/bake-safe.js`, and a name is only checked on a page whose **source** references it, so a coincidental literal is never flagged. "Preservable context" is single-sourced with the marker pass (`mark-attributes.wrappableRefs`), so the checker expects a reference exactly where marking provides one — references correctly baked in a heading / image alt / unused `:description:` are not required.
- **Examples** — a page that pulls `example$` includes must import at least one example file, not bake them all as literal fences. (Matching is by presence, not name: the converter dedupes identical-content examples to one import, so name-matching would false-positive.)

Source-anchoring is what makes "all referenced attributes" tractable: a value like `hazelcast-cloud` → `"Cloud"` is only sought on pages whose source says `{hazelcast-cloud}`, so the common word "Cloud" elsewhere is never a false positive. It is strictly more precise than the converter's own `auditStillBaked` warning (which string-matches a value anywhere and so false-positives on e.g. a literal `5.7.0` in the api-ref CRD table).

Shares `lib/layout.js` (source repo/branch + version/path config) with the converter so the two resolve sources and output paths identically.

## Gotchas worth remembering

- The pin is enforced by the mirrors **not moving**, not by the lockfile: Antora builds branch *tips*, so `lockfile.json` only *records* the SHAs — freezing them means never updating the mirror. `runtime.fetch: false` guarantees a build never moves a ref.
- To advance the baseline (fold in upstream changes): `git -C .sources/<repo>.git remote update --prune`, re-run the index pass, regenerate the golden snapshot — together, deliberately. The snapshot's pin check keeps them in step.
- Runs are offline (mirrors are local); only populating/advancing a mirror needs network.
- Per-version conditionals (e.g. `ifdef::snapshot`) resolve correctly because each page renders with its **own** component-version AsciiDoc config.
- The manifest deliberately excludes partials/examples (no URL) — the include graph is separate, unbuilt work.
- `onBrokenLinks` must be `'warn'` during migration (links point at not-yet-migrated pages); flip to `'throw'` at cutover.

## Status

Built: index pass, golden-snapshot builder (with `--component` scoping for smoke tests), all three gates (fidelity harness, reference checker, construct-coverage gate) and the converter. Not yet built: CI wiring for `npm run check`, the include graph, Swagger handling.
