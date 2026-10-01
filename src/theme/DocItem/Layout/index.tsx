import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocVersionBanner from '@theme/DocVersionBanner';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemContent from '@theme/DocItem/Content';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import ContentVisibility from '@theme/ContentVisibility';
import FeedbackButton from '@site/src/components/FeedbackButton';
import EditPageButton from '@site/src/components/EditPageButton';
import type {Props} from '@theme/DocItem/Layout';
import {ApiTocProvider, useApiTocState} from '@site/src/components/ApiReference/apiToc';

import styles from './styles.module.css';

// Ejected from theme-classic: (1) API-reference pages have no MDX headings, so the TOC decision also considers
// operations published from the content (src/components/ApiReference/apiToc.tsx); (2) the version badge moved into
// DocItem/Content's badge row; (3) no DocItemFooter: its only content here was the edit link, now EditPageButton in the rail.
// Otherwise stock; re-diff on upgrade.

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

  // The rail holds the TOC and the feedback and edit buttons, so it renders even when the TOC is empty.
  // `hide_table_of_contents` still suppresses the whole rail. Desktop only.
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
            </article>
            <DocItemPaginator />
          </div>
        </div>
        {showRail && (
          <div className={clsx('col col--3', styles.railCol)}>
            <div className={styles.rail}>
              {docTOC.desktop}
              <div className={styles.railActions}>
                <FeedbackButton />
                <EditPageButton />
              </div>
            </div>
          </div>
        )}
      </div>
    </ApiTocProvider>
  );
}
