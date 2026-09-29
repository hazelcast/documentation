import {useLocation, matchPath} from '@docusaurus/router';
import {
  useActivePluginAndVersion,
  type GlobalVersion,
} from '@docusaurus/plugin-content-docs/client';

// The current page's counterpart in the latest released version (`isLast`).
// Undefined outside a docs page and on the latest version; `path` is undefined if the page is absent there.
//
// Matched on URL, NOT doc id: ids follow the source tree, which differs between versions, while URLs are stable.
// This is also why Docusaurus's id-keyed `alternateDocVersions` / `useDocVersionSuggestions` cannot be used.
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
