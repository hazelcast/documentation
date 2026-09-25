import React, {type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import SiteMetadata from '@theme-original/SiteMetadata';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {applyTrailingSlash} from '@docusaurus/utils-common';
import useLatestCounterpart from '@site/src/lib/useLatestCounterpart';

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
//
// No counterpart means the page genuinely does not exist in the released
// version; canonicalising there would point at a 404, so it keeps the self-
// canonical.
export default function SiteMetadataWrapper(): ReactNode {
  const {
    siteConfig: {url: siteUrl, baseUrl, trailingSlash},
  } = useDocusaurusContext();
  const latestPath = useLatestCounterpart()?.path;

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
