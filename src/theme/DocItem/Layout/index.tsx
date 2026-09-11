import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocVersionBanner from '@theme/DocVersionBanner';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemContent from '@theme/DocItem/Content';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import ContentVisibility from '@theme/ContentVisibility';
import FeedbackButton from '@site/src/components/FeedbackButton';
import type {Props} from '@theme/DocItem/Layout';
import {ApiTocProvider, useApiTocState} from '@site/src/components/ApiReference/apiToc';

import styles from './styles.module.css';

// Ejected from theme-classic for two reasons. (1) An API-reference page has no
// MDX headings, so the stock `toc.length > 0` test hides the TOC column on
// exactly the pages that need it most. Its operations are discovered in the
// browser and published up from the content
// (src/components/ApiReference/apiToc.tsx), so the decision also has to consider
// what has been published so far. (2) The stock `<DocVersionBadge/>` that sat
// here is gone: it now rides in the badge row that DocItem/Content renders, so
// the version pill and the page-level badges share one line. Everything else
// here is stock — keep it that way, and re-diff against theme-classic on
// upgrade.

/**
 * Decide if the toc should be rendered, on mobile or desktop viewports
 */
function useDocTOC(apiTocItems: readonly unknown[]) {
  const {frontMatter, toc} = useDoc();
  const windowSize = useWindowSize();

  const hidden = frontMatter.hide_table_of_contents;
  const canRender = !hidden && (toc.length > 0 || apiTocItems.length > 0);

  const mobile = canRender ? <DocItemTOCMobile /> : undefined;

  const desktop =
    canRender && (windowSize === 'desktop' || windowSize === 'ssr') ? (
      <DocItemTOCDesktop />
    ) : undefined;

  return {
    hidden,
    mobile,
    desktop,
  };
}

export default function DocItemLayout({children}: Props): ReactNode {
  const apiToc = useApiTocState();
  const docTOC = useDocTOC(apiToc.items);
  const {metadata} = useDoc();
  const windowSize = useWindowSize();

  // The rail carries the TOC and, under it, the feedback button — so unlike
  // stock it has to render on a page whose TOC is empty, which is how
  // production behaves (Antora's main.hbs includes the toc partial
  // unconditionally, and the feedback block is a sibling of the TOC aside
  // inside .toc-container, not a child of it). ~690 of our pages have no
  // headings, so keying the rail on the TOC would lose the button on about a
  // fifth of the docs.
  //
  // `hide_table_of_contents` still suppresses the whole rail: a page that has
  // asked for the full width gets it, feedback button included. Nothing sets
  // that today, and the content column is capped at 75% whenever it is unset
  // (styles.module.css), so the space the rail now always occupies was already
  // reserved — this widens nothing and narrows nothing.
  //
  // Desktop only, as the rail always was. That leaves phones and tablets with
  // no feedback button, which matches production, where .toc.sidebar is hidden
  // below 1024px.
  const showRail =
    !docTOC.hidden && (windowSize === 'desktop' || windowSize === 'ssr');
  return (
    <ApiTocProvider items={apiToc.items} publish={apiToc.publish}>
      <div className="row">
        <div className={clsx('col', !docTOC.hidden && styles.docItemCol)}>
          <ContentVisibility metadata={metadata} />
          <DocVersionBanner />
          <div className={styles.docItemContainer}>
            <article>
              <DocBreadcrumbs />
              {docTOC.mobile}
              <DocItemContent>{children}</DocItemContent>
              <DocItemFooter />
            </article>
            <DocItemPaginator />
          </div>
        </div>
        {showRail && (
          <div className={clsx('col col--3', styles.railCol)}>
            <div className={styles.rail}>
              {docTOC.desktop}
              <FeedbackButton />
            </div>
          </div>
        )}
      </div>
    </ApiTocProvider>
  );
}
