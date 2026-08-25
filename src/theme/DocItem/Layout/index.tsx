import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocVersionBanner from '@theme/DocVersionBanner';
import DocVersionBadge from '@theme/DocVersionBadge';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemContent from '@theme/DocItem/Content';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import ContentVisibility from '@theme/ContentVisibility';
import type {Props} from '@theme/DocItem/Layout';
import {ApiTocProvider, useApiTocState} from '@site/src/components/ApiReference/apiToc';

import styles from './styles.module.css';

// Ejected from theme-classic for ONE reason: an API-reference page has no MDX
// headings, so the stock `toc.length > 0` test hides the TOC column on exactly
// the pages that need it most. Its operations are discovered in the browser and
// published up from the content (src/components/ApiReference/apiToc.tsx), so the
// decision also has to consider what has been published so far. Everything else
// here is stock — keep it that way, and re-diff against theme-classic on upgrade.

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
  return (
    <ApiTocProvider items={apiToc.items} publish={apiToc.publish}>
      <div className="row">
        <div className={clsx('col', !docTOC.hidden && styles.docItemCol)}>
          <ContentVisibility metadata={metadata} />
          <DocVersionBanner />
          <div className={styles.docItemContainer}>
            <article>
              <DocBreadcrumbs />
              <DocVersionBadge />
              {docTOC.mobile}
              <DocItemContent>{children}</DocItemContent>
              <DocItemFooter />
            </article>
            <DocItemPaginator />
          </div>
        </div>
        {docTOC.desktop && <div className="col col--3">{docTOC.desktop}</div>}
      </div>
    </ApiTocProvider>
  );
}
