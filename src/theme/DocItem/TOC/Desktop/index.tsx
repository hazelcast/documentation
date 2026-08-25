import React, {type ReactNode} from 'react';
import Original from '@theme-original/DocItem/TOC/Desktop';
import {ThemeClassNames} from '@docusaurus/theme-common';
import TOC from '@theme/TOC';
import {useApiTocItems} from '@site/src/components/ApiReference/apiToc';

// An API-reference page's TOC entries are its operations, discovered in the
// browser rather than from MDX headings (see ApiReference/apiToc.tsx). On every
// other page this defers to the stock component untouched.
export default function DocItemTOCDesktop(): ReactNode {
  const apiTocItems = useApiTocItems();
  if (apiTocItems.length === 0) {
    return <Original />;
  }
  return <TOC toc={apiTocItems} className={ThemeClassNames.docs.docTocDesktop} />;
}
