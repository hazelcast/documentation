import React, {type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import SiteMetadata from '@theme-original/SiteMetadata';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useLocation, matchPath} from '@docusaurus/router';
import {applyTrailingSlash} from '@docusaurus/utils-common';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';

// Antora emitted a cross-version canonical for free: every version of a page
// declared the latest RELEASED version's URL as its canonical. Stock Docusaurus
// canonicals each page to itself, so migrating as-is would drop that signal
// while the sitemap still advertises every version — old versions would be left
// competing with current ones in search with nothing pointing the other way.
//
// Wrapped rather than ejected because react-helmet dedupes <link rel=canonical>
// on `rel` ALONE — its link dedup key is normally rel+href, but canonical is an
// explicit special case — so a canonical rendered after the original REPLACES
// it rather than doubling it. Two canonicals would make Google ignore both.
// Same for og:url, which the stock component sets to the same value.
function useLatestVersionPath(): string | undefined {
  const {pathname} = useLocation();
  const active = useActivePluginAndVersion();

  const activeVersion = active?.activeVersion;
  if (!activeVersion) {
    // Not a docs page: the landing page, /privacy, and anything else outside a
    // docs plugin instance keep the stock self-canonical.
    return undefined;
  }

  // `isLast` is the latest RELEASED version, not the in-development snapshot,
  // so snapshots canonical to the release as well — as Antora did.
  const latest = active.activePlugin.pluginData.versions.find((v) => v.isLast);
  if (!latest || latest.name === activeVersion.name) {
    return undefined;
  }

  const activeDoc = activeVersion.docs.find((doc) =>
    matchPath(pathname, {path: doc.path, exact: true, strict: false}),
  );
  if (!activeDoc) {
    return undefined;
  }

  // Matched on URL, NOT on doc id — deliberately, and not the same thing here.
  // A doc's id is its path in the source tree, which was reorganised between
  // versions, while the URL was preserved from Antora. So the 5.3 and 5.7 copies
  // of one page share a URL suffix but have different ids: id-matching finds
  // only 9 of 368 counterparts for 5.3, URL-matching finds 338. This is also
  // why Docusaurus's own `alternateDocVersions` (id-keyed) cannot be used.
  const suffix = activeDoc.path.slice(activeVersion.path.length);
  const counterpart = latest.docs.find(
    (doc) => doc.path === latest.path + suffix,
  );

  // No counterpart means the page genuinely does not exist in the released
  // version; canonicalising there would point at a 404, so it keeps the self-
  // canonical.
  return counterpart?.path;
}

export default function SiteMetadataWrapper(): ReactNode {
  const {
    siteConfig: {url: siteUrl, baseUrl, trailingSlash},
  } = useDocusaurusContext();
  const latestPath = useLatestVersionPath();

  const canonicalUrl = latestPath
    ? siteUrl + applyTrailingSlash(latestPath, {trailingSlash, baseUrl})
    : undefined;

  return (
    <>
      <SiteMetadata />
      {canonicalUrl && (
        <Head>
          <link rel="canonical" href={canonicalUrl} />
          <meta property="og:url" content={canonicalUrl} />
        </Head>
      )}
    </>
  );
}
