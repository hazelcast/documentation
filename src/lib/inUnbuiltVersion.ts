import type {GlobalPluginData} from '@docusaurus/plugin-content-docs/client';

const within = (path: string, base: string) =>
  path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);

// True when `href` is under a docs component but in none of its built versions, e.g. a retired release.
export default function inUnbuiltVersion(
  href: string,
  allDocsData: Record<string, GlobalPluginData>,
): boolean {
  const path = href.split(/[?#]/)[0];
  return Object.values(allDocsData).some(
    (plugin) =>
      within(path, plugin.path) && !plugin.versions.some((version) => within(path, version.path)),
  );
}
