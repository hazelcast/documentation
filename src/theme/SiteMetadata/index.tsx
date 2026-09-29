import React, {type ReactNode} from 'react';
import Head from '@docusaurus/Head';
import SiteMetadata from '@theme-original/SiteMetadata';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {applyTrailingSlash} from '@docusaurus/utils-common';
import useLatestCounterpart from '@site/src/lib/useLatestCounterpart';

// Canonicalises every version of a page to the latest released version's URL (stock canonicals each page to itself)
// so old versions don't compete in search.
// Wrapped, not ejected: react-helmet dedupes canonical on `rel` alone, so ours replaces the original (two would make
// Google ignore both). Same for og:url.
// No counterpart in the released version keeps the self-canonical, to avoid pointing at a 404.
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
