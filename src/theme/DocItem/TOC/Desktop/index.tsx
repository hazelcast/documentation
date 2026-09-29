import React, {type ReactNode} from 'react';
import Original from '@theme-original/DocItem/TOC/Desktop';
import {ThemeClassNames} from '@docusaurus/theme-common';
import TOC from '@theme/TOC';
import {useApiTocItems} from '@site/src/components/ApiReference/apiToc';

// API-reference TOC entries are operations discovered in the browser (see ApiReference/apiToc.tsx); other pages defer to stock.
export default function DocItemTOCDesktop(): ReactNode {
  const apiTocItems = useApiTocItems();
  if (apiTocItems.length === 0) {
    return <Original />;
  }
  return <TOC toc={apiTocItems} className={ThemeClassNames.docs.docTocDesktop} />;
}
