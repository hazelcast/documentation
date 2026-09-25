import {useLocation, matchPath} from '@docusaurus/router';
import {
  useActivePluginAndVersion,
  type GlobalVersion,
} from '@docusaurus/plugin-content-docs/client';

// The current page's counterpart in the latest RELEASED version (`isLast`, so a
// snapshot resolves to the release too). Undefined outside a docs page and on
// the latest version itself; `path` is undefined when the page does not exist in
// the latest version.
//
// Matched on URL, NOT on doc id — deliberately, and not the same thing here.
// A doc's id is its path in the source tree, which was reorganised between
// versions, while the URL was preserved from Antora. So the 5.3 and 5.7 copies
// of one page share a URL suffix but have different ids: id-matching finds
// only 9 of 368 counterparts for 5.3, URL-matching finds 338. This is also
// why Docusaurus's own id-keyed `alternateDocVersions` and
// `useDocVersionSuggestions` cannot be used.
export default function useLatestCounterpart():
  | {latest: GlobalVersion; path: string | undefined}
  | undefined {
  const {pathname} = useLocation();
  const active = useActivePluginAndVersion();

  const activeVersion = active?.activeVersion;
  if (!activeVersion) {
    return undefined;
  }
  const latest = active.activePlugin.pluginData.versions.find((v) => v.isLast);
  if (!latest || latest.name === activeVersion.name) {
    return undefined;
  }

  const activeDoc = activeVersion.docs.find((doc) =>
    matchPath(pathname, {path: doc.path, exact: true, strict: false}),
  );
  const suffix = activeDoc?.path.slice(activeVersion.path.length);
  const counterpart =
    suffix === undefined
      ? undefined
      : latest.docs.find((doc) => doc.path === latest.path + suffix);
  return {latest, path: counterpart?.path};
}
