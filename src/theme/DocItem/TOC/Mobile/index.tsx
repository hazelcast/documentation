import React, {type ReactNode} from 'react';
import Original from '@theme-original/DocItem/TOC/Mobile';
import {ThemeClassNames} from '@docusaurus/theme-common';
import TOCCollapsible from '@theme/TOCCollapsible';
import {useApiTocItems} from '@site/src/components/ApiReference/apiToc';
import clsx from 'clsx';

import styles from './styles.module.css';

// Mobile counterpart of DocItem/TOC/Desktop — same substitution, same fallback.
export default function DocItemTOCMobile(): ReactNode {
  const apiTocItems = useApiTocItems();
  if (apiTocItems.length === 0) {
    return <Original />;
  }
  return (
    <TOCCollapsible
      toc={apiTocItems}
      className={clsx(ThemeClassNames.docs.docTocMobile, styles.tocMobile)}
    />
  );
}
