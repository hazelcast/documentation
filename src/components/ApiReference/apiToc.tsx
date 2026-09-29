import React, {createContext, useCallback, useContext, useMemo, useState} from 'react';
import type {TOCItem} from '@docusaurus/mdx-loader';

// Bridges an API reference's operations into the page's "On this page" TOC. An API page has no MDX headings; the operations are only known once Redoc parses the spec in the browser.
// State lives in the swizzled DocItem/Layout, the common ancestor of the TOC column (stock Docusaurus omits it when the MDX toc is empty) and the content that publishes the items.

const ApiTocItemsContext = createContext<readonly TOCItem[]>([]);
const ApiTocPublishContext = createContext<(items: readonly TOCItem[]) => void>(() => {});

export function useApiTocItems(): readonly TOCItem[] {
  return useContext(ApiTocItemsContext);
}

export function usePublishApiToc(): (items: readonly TOCItem[]) => void {
  return useContext(ApiTocPublishContext);
}

const sameItems = (a: readonly TOCItem[], b: readonly TOCItem[]) =>
  a.length === b.length && a.every((item, i) => item.id === b[i]!.id && item.value === b[i]!.value);

// Idempotent: the content republishes on every render and an unchanged list must not trigger another one.
export function useApiTocState(): {
  items: readonly TOCItem[];
  publish: (items: readonly TOCItem[]) => void;
} {
  const [items, setItems] = useState<readonly TOCItem[]>([]);
  const publish = useCallback(
    (next: readonly TOCItem[]) => setItems((prev) => (sameItems(prev, next) ? prev : next)),
    [],
  );
  return useMemo(() => ({items, publish}), [items, publish]);
}

export function ApiTocProvider({
  items,
  publish,
  children,
}: {
  items: readonly TOCItem[];
  publish: (items: readonly TOCItem[]) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ApiTocPublishContext.Provider value={publish}>
      <ApiTocItemsContext.Provider value={items}>{children}</ApiTocItemsContext.Provider>
    </ApiTocPublishContext.Provider>
  );
}
