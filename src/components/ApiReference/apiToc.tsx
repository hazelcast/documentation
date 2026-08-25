import React, {createContext, useCallback, useContext, useMemo, useState} from 'react';
import type {TOCItem} from '@docusaurus/mdx-loader';

// Bridges an API reference's operation list into the page's ordinary "On this
// page" table of contents.
//
// A normal page's TOC is built from its MDX headings at BUILD time. An API page
// has no headings: its whole body is one <ApiReference/>, and what a reader
// wants to navigate — the operations — is only known once Redoc has parsed the
// spec in the browser. So the operations travel the other way, from the rendered
// content back up to the TOC column.
//
// The state lives in the swizzled DocItem/Layout because Layout is the common
// ancestor of both halves: it decides whether the TOC column exists at all
// (stock Docusaurus renders it only when the MDX toc is non-empty, which for
// these pages it never is), and it renders the content that publishes the items.

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

// Owned by DocItem/Layout: `items` drives the TOC column, `publish` is handed
// down to the content. Publishing is idempotent — the component republishes on
// every render and an unchanged list must not trigger another one.
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
