// The docs plugin instances, one per component; adding a component is one line in docusaurus.config.ts.
//
// Owns the on-disk files Docusaurus hardcodes as `<siteDir>/<pluginId>_*` (no config hook):
//   <id>_versions.json        live release list, newest first (committed; the single source)
//   <id>_versioned_docs/      cut copy of each release's pages
//   <id>_versioned_sidebars/  sidebar stubs, gitignored (see ensureVersionedSidebars)
import fs from 'fs';
import path from 'path';
import type {PluginConfig} from '@docusaurus/types';
import type {Options} from '@docusaurus/plugin-content-docs';
import latestLinks, {type LatestSegs} from './remark/latestLinks';
import headingVariables from './remark/headingVariables';
import imageAltUnescape from './remark/imageAltUnescape';
import tableCodeBreaks from './remark/tableCodeBreaks';

const siteDir = path.resolve(__dirname, '..');

// Version segment each versioned component's `/latest/` alias resolves to, filled by versionedDocs().
// Exported for `customFields` (landing page). Passed by reference and read after config evaluation, so key order does not matter.
export const latestSegs: LatestSegs = {};

// Version segment of each component's unreleased snapshot line; components whose main is the newest release contribute nothing.
const snapshotSegs: {[id: string]: string} = {};

// True for a sitemap URL under a snapshot segment (snapshots' canonicals point at the latest release).
// Reads the registry at call time: `presets` is evaluated before `plugins`, so the map is still empty when sitemap options are built.
export function isSnapshotUrl(url: string): boolean {
  const {pathname} = new URL(url);
  return Object.entries(snapshotSegs).some(
    ([id, seg]) => pathname === `/${id}/${seg}` || pathname.startsWith(`/${id}/${seg}/`),
  );
}

// Keeps only the sitemap items that are their own canonical: drops snapshot pages, and an older release's page whenever
// the latest release has a page at the same URL suffix (src/theme/SiteMetadata canonicals it there).
export function canonicalSitemapItems<T extends {url: string}>(items: T[]): T[] {
  const pathnames = new Set(items.map((item) => new URL(item.url).pathname));
  return items.filter(({url}) => {
    if (isSnapshotUrl(url)) {
      return false;
    }
    const [, id, seg, ...rest] = new URL(url).pathname.split('/');
    const latestSeg = id === undefined ? undefined : latestSegs[id];
    if (latestSeg === undefined || seg === latestSeg) {
      return true;
    }
    return !pathnames.has(['', id, latestSeg, ...rest].join('/'));
  });
}

// `caution`/`important` are not default Docusaurus admonition keywords; fidelity Layer 2 compares admonition types.
const admonitions = {keywords: ['caution', 'important'], extendDefaults: true};

// Sidebar badge from a doc's frontmatter, as a class that src/css/custom.css turns into a pill. Beta wins over enterprise: there is no room for both.
function navBadgeClass(frontMatter: {[key: string]: unknown} | undefined): string | undefined {
  if (frontMatter?.beta === true) return 'nav-badge-beta';
  if (frontMatter?.enterprise === true) return 'nav-badge-enterprise';
  return undefined;
}

type GeneratorArgs = Parameters<NonNullable<Options['sidebarItemsGenerator']>>[0];
type SidebarItems = Awaited<ReturnType<GeneratorArgs['defaultSidebarItemsGenerator']>>;

// Wraps the default generator to tag each doc link, and each category whose landing page is a doc, with its badge class.
const sidebarItemsGenerator: NonNullable<Options['sidebarItemsGenerator']> = async ({
  defaultSidebarItemsGenerator,
  ...args
}) => {
  const frontMatterById = new Map(args.docs.map((doc) => [doc.id, doc.frontMatter as {[key: string]: unknown}]));
  const tag = (items: SidebarItems): SidebarItems =>
    items.map((item) => {
      const docId = item.type === 'doc' ? item.id : item.type === 'category' && item.link?.type === 'doc' ? item.link.id : undefined;
      const badge = docId === undefined ? undefined : navBadgeClass(frontMatterById.get(docId));
      const tagged = badge ? {...item, className: [item.className, badge].filter(Boolean).join(' ')} : item;
      return tagged.type === 'category' ? {...tagged, items: tag(tagged.items)} : tagged;
    });
  return tag(await defaultSidebarItemsGenerator({...args}));
};

// `sidebarPath` is deliberately unset: the built-in default autogenerates one `defaultSidebar` per plugin instance from the folder tree,
// which mirrors the Antora nav order. Navbar items reference `sidebarId: 'defaultSidebar'`.
function contentDocs(options: Options): PluginConfig {
  return [
    '@docusaurus/plugin-content-docs',
    {
      ...options,
      // Docusaurus appends each page's repo-relative path, so versioned pages link to their own copy under <id>_versioned_docs.
      editUrl: 'https://github.com/hazelcast/documentation/edit/main/',
      sidebarItemsGenerator,
      beforeDefaultRemarkPlugins: [
        ...(options.beforeDefaultRemarkPlugins ?? []),
        [headingVariables, {pluginId: options.id}],
      ],
      remarkPlugins: [
        ...(options.remarkPlugins ?? []),
        [latestLinks, {latest: latestSegs}],
        imageAltUnescape,
        tableCodeBreaks,
      ],
    },
  ];
}

// An unversioned component: served at the base path with no version segment.
export function docs(id: string): PluginConfig {
  return contentDocs({id, path: id, routeBasePath: id, admonitions});
}

// A versioned component: every version, including current, gets an explicit `path`.
// Otherwise a new release would take Docusaurus's default '' path for `lastVersion` and claim the bare `/<component>/` root.
//
// src/currentVersions.json (keyed by plugin id) holds what is not derivable from <id>_versions.json:
// - `currentSeg`: URL segment for main (`latest-snapshot`, a release number, or a numbered snapshot).
// - `currentLabel`: dropdown text where it differs from the segment (defaults to currentSeg).
// - `defaultVersion`: `latest-release` where main is an unreleased snapshot, `current` where main is the newest release.
//
// To show only some releases, add `onlyIncludeVersions` (subset of <id>_versions.json plus 'current'); `lastVersion` must be one of them.
// De-listing a release with page-aliases also needs those entries dropped from src/redirects.ts.
export function versionedDocs(id: string): PluginConfig {
  const current = currentVersions[id];
  if (!current) {
    throw new Error(`Versioned docs instance '${id}' has no entry in src/currentVersions.json.`);
  }
  const {currentSeg, currentLabel = currentSeg, defaultVersion} = current;
  const releases = readReleases(id);
  if (defaultVersion === 'latest-release' && releases.length === 0) {
    throw new Error(
      `Docs instance '${id}' has defaultVersion: 'latest-release' but ${id}_versions.json lists no releases.`,
    );
  }
  ensureVersionedSidebars(id, releases);
  // `/<id>/latest/` points at `lastVersion`; same expression as below so it cannot drift from `isLast`.
  latestSegs[id] = defaultVersion === 'current' ? currentSeg : releases[0]!;
  if (defaultVersion === 'latest-release') {
    snapshotSegs[id] = currentSeg;
  }
  return contentDocs({
    id,
    path: id,
    routeBasePath: id,
    lastVersion: defaultVersion === 'current' ? 'current' : releases[0],
    versions: {
      current: {label: currentLabel, path: currentSeg},
      ...Object.fromEntries(releases.map((version) => [version, {path: version}])),
    },
    admonitions,
  });
}

type CurrentVersion = {
  currentSeg: string;
  currentLabel?: string;
  defaultVersion: 'current' | 'latest-release';
};

const currentVersions = readCurrentVersions();

// Every versioned component with the URL segment its current version is served
// at, for plugins that stage per-version files (openapi-specs).
export const versionedInstances = Object.entries(currentVersions).map(([id, {currentSeg}]) => ({
  id,
  currentSeg,
}));

function readCurrentVersions(): {[id: string]: CurrentVersion} {
  const file = path.join(siteDir, 'src', 'currentVersions.json');
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('src/currentVersions.json must be an object keyed by docs plugin id.');
  }
  for (const [id, entry] of Object.entries(entries)) {
    const {currentSeg, currentLabel, defaultVersion} = (entry ?? {}) as Partial<CurrentVersion>;
    if (
      typeof currentSeg !== 'string' ||
      (currentLabel !== undefined && typeof currentLabel !== 'string') ||
      (defaultVersion !== 'current' && defaultVersion !== 'latest-release')
    ) {
      throw new Error(
        `src/currentVersions.json: '${id}' needs a string currentSeg, an optional string currentLabel, and defaultVersion 'current' or 'latest-release'.`,
      );
    }
  }
  return entries as {[id: string]: CurrentVersion};
}

// The live release set; generated by the converter, prepended to by `docusaurus docs:version`. The only place versions are listed.
function readReleases(id: string): string[] {
  const file = path.join(siteDir, `${id}_versions.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Versioned docs instance '${id}' needs a ${id}_versions.json at the site root, listing its releases newest first.`,
    );
  }
  const releases = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(releases) || releases.some((v) => typeof v !== 'string')) {
    throw new Error(`${id}_versions.json must be an array of version names, newest first.`);
  }
  return releases as string[];
}

// Per-release sidebar stubs (`<id>_versioned_sidebars/version-X-sidebars.json`). A missing versioned stub means no left nav
// on that release, so they are required, but they are gitignored build artefacts: written here, deleted at exit.
// Written from config evaluation so npm `pre*` hooks cannot be bypassed.
// A file that is not our stub is left alone (un-ignore and commit it to hand-tune one release).
const STUB =
  JSON.stringify({defaultSidebar: [{type: 'autogenerated', dirName: '.'}]}, null, 2) + '\n';

// Kept on globalThis, not module scope: the dev server re-evaluates this module on every config change.
const generated: Set<string> = ((globalThis as Record<string, unknown>).__hzGeneratedSidebarStubs ??=
  new Set<string>()) as Set<string>;

function ensureVersionedSidebars(id: string, releases: string[]): void {
  const dir = path.join(siteDir, `${id}_versioned_sidebars`);
  fs.mkdirSync(dir, {recursive: true});
  for (const version of releases) {
    const file = path.join(dir, `version-${version}-sidebars.json`);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing === null) {
      fs.writeFileSync(file, STUB);
    } else if (existing !== STUB) {
      continue; // hand-tuned: not ours to write or remove
    }
    // Either we just wrote it, or a previous run (or `docs:version`) left our own
    // stub behind — clean up both.
    generated.add(file);
  }
  hookCleanup();
}

// An 'exit' listener covers Ctrl-C (Docusaurus's SIGINT handlers call process.exit()) and normal completion.
// A SIGKILL or crash leaves the stubs; the next run adopts and removes them.
// Not `postBuild`: the dev server never reaches it, and it fires per locale.
function hookCleanup(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__hzSidebarStubCleanupHooked) return;
  g.__hzSidebarStubCleanupHooked = true;
  process.on('exit', removeGeneratedStubs);
}

// Synchronous: an 'exit' listener cannot await.
function removeGeneratedStubs(): void {
  const dirs = new Set<string>();
  for (const file of generated) {
    try {
      fs.rmSync(file);
      dirs.add(path.dirname(file));
    } catch {
      // Already gone (a concurrent run, a manual delete) — nothing to do.
    }
  }
  generated.clear();
  // Remove the folder only if our stubs were all it held; rmdirSync fails harmlessly otherwise.
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty: something committed lives here.
    }
  }
}
