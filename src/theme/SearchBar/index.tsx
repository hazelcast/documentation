// DocSearch plus a product filter bar injected into its modal (a wrapper, not an eject).
// DocSearch has no header slot, so buttons are portalled into a div we insert, and re-querying relies on two
// internals noted at their use sites, read off @docsearch/react v4; re-check when Docusaurus upgrades.
import React, {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import SearchBar from '@theme-original/SearchBar';
import {Button} from '@hazelcast/ui/lib/components/Button';
import {ButtonGroup} from '@hazelcast/ui/lib/components/ButtonGroup';
import AskAiIcon from '@site/src/components/NavbarAskAi/AskAiIcon';
import type SearchBarType from '@theme/SearchBar';
import type {WrapperProps} from '@docusaurus/types';
import type {DocSearchHit, DocSearchTransformClient} from '@docsearch/react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useSearchResultUrlProcessor} from '@docusaurus/theme-search-algolia/client';
import {pushDataLayer} from '@site/src/lib/analytics';
import styles from './styles.module.css';

type Props = WrapperProps<typeof SearchBarType>;

// Filter bar products. Each `id` is a value of the index's `product` facet (version-free; the index holds only the latest release).
const PRODUCTS = [
  {id: 'hazelcast', label: 'Platform'},
  {id: 'cloud', label: 'Cloud'},
  {id: 'management-center', label: 'Management Center'},
  {id: 'operator', label: 'Operator'},
  {id: 'clc', label: 'CLC'},
  {id: 'tutorials', label: 'Tutorials'},
] as const;

// "All" is an OR over the products rather than no filter, which keeps pages
// outside every product (`/privacy`) out of the results.
const ALL_PRODUCTS = PRODUCTS.map(({id}) => `product:${id}`);

// `search_component` value when no product filter is applied.
const ALL_COMPONENTS = 'All';

// Algolia facetFilters: outer array ANDs, nested ORs. One nested element: none selected ORs every product, one narrows.
const filtersFor = (id: string | null): string[] => (id ? [`product:${id}`] : ALL_PRODUCTS);

// How many hits each product shows under "All". A single product is uncapped.
const ALL_PER_PRODUCT = 4;

const HITS_PER_PAGE = 60;

// DocSearch's default attributesToRetrieve plus `breadcrumb`; passing any list replaces the default, so it is repeated.
const ATTRIBUTES_TO_RETRIEVE = [
  'hierarchy.lvl0',
  'hierarchy.lvl1',
  'hierarchy.lvl2',
  'hierarchy.lvl3',
  'hierarchy.lvl4',
  'hierarchy.lvl5',
  'hierarchy.lvl6',
  'content',
  'type',
  'url',
  'breadcrumb',
];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The grey line under a hit shows the page's nav path (from the crawler's `breadcrumb`). DocSearch renders it from
// `_snippetResult.hierarchy.lvl1.value` (HTML), so the path is written there, escaped. Page-level hits keep their snippet.
function withNavPath(item: DocSearchHit): DocSearchHit {
  const {breadcrumb} = item as DocSearchHit & {breadcrumb?: string[]};
  if (item.type === 'lvl1' || !breadcrumb?.length) return item;
  const snippets = item._snippetResult;
  return {
    ...item,
    _snippetResult: {
      ...snippets,
      hierarchy: {
        ...snippets?.hierarchy,
        lvl1: {...snippets?.hierarchy?.lvl1, value: escapeHtml(breadcrumb.join(' › '))},
      },
    },
  } as DocSearchHit;
}

// Re-run the current query. DocSearch doesn't expose autocomplete's refresh(), so dispatch a native `input` event,
// which React routes to onChange like a keystroke. React drops the event when the value matches what it last saw, so
// its internal `_valueTracker` (read off React 19; re-check on upgrade) is cleared first.
function requery(): void {
  const input = document.querySelector<HTMLInputElement>('.DocSearch-Input');
  if (!input) return;
  (input as HTMLInputElement & {_valueTracker?: {setValue(value: string): void}})._valueTracker?.setValue('');
  input.dispatchEvent(new Event('input', {bubbles: true}));
  // The click moved focus to the button; put the caret back so typing continues.
  input.focus();
}

function ProductFilters({
  selected,
  onSelect,
  query,
  onAskAi,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  query: string;
  onAskAi: () => void;
}) {
  return (
    // A HIVE ButtonGroup (renders its own role/aria-label). The scroll wrapper is ours: the group doesn't wrap and overruns the modal.
    <div className={styles.bar}>
      <div className={styles.filters}>
        <ButtonGroup ariaLabel="Filter results by product">
          {[{id: null, label: 'All'}, ...PRODUCTS].map(({id, label}) => (
            <Button
              key={id ?? 'all'}
              type="button"
              variant={selected === id ? 'contained' : 'outlined'}
              // Only the outlined buttons need the dark-mode fix; see the CSS.
              className={selected === id ? undefined : styles.outlined}
              {...({'aria-pressed': selected === id} as React.AriaAttributes)}
              onClick={() => onSelect(id)}>
              {label}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      <div className={styles.footer}>
        <p className={styles.scope}>
          Results are from the latest released version of each product.<br/>
          Use the AI search tool for information about older versions.
        </p>
        {/* Hands the typed query to Kapa; the label names it. */}
        <Button
          type="button"
          variant="contained"
          color="secondary"
          iconLeft={AskAiIcon}
          iconLeftAriaLabel="Ask AI"
          truncate
          className={styles.askAi}
          onClick={onAskAi}>
          {query ? `Ask AI about "${query}"` : 'Ask AI'}
        </Button>
      </div>
    </div>
  );
}

export default function SearchBarWrapper(props: Props): ReactNode {
  // The array DocSearch reads facet filters from. It captures `searchParameters` once but dereferences `.facetFilters`
  // at query time, so mutating this array in place changes the next query without remounting. A ref so identity survives renders.
  const facetFilters = useRef<string[][]>([filtersFor(null)]).current;

  // Deeper pool for a single product (DocSearch asks for 20). Under "All" the search client fans out instead.
  const searchParameters = useRef({
    facetFilters,
    hitsPerPage: HITS_PER_PAGE,
    attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
  }).current;
  const [selected, setSelected] = useState<string | null>(null);

  const onSelect = useCallback(
    (id: string | null) => {
      setSelected(id);
      facetFilters[0] = filtersFor(id);
      requery();
    },
    [facetFilters],
  );

  // Under "All", one OR query over every product returns the top hits by relevance, which a large product (Platform)
  // can fill entirely. So the search client sends one query per product instead and merges the hits in PRODUCTS order.
  // A single product is passed through. Algolia bills each query, so "All" costs one per product.
  const {
    siteMetadata: {docusaurusVersion},
  } = useDocusaurusContext();
  const transformSearchClient = useCallback(
    (client: DocSearchTransformClient): DocSearchTransformClient => {
      // Docusaurus's own transform, which a `transformSearchClient` prop replaces.
      client.addAlgoliaAgent('docusaurus', docusaurusVersion);
      const search = client.search.bind(client) as (...args: any[]) => Promise<any>;
      client.search = (async (params: any, ...rest: any[]) => {
        const [base] = params?.requests ?? [];
        const first = base?.facetFilters?.[0];
        const isAll = params.requests.length === 1 && Array.isArray(first) && first.length === ALL_PRODUCTS.length;
        if (!isAll) return search(params, ...rest);
        const {results} = await search(
          {
            ...params,
            requests: PRODUCTS.map(({id}) => ({
              ...base,
              facetFilters: [`product:${id}`],
              hitsPerPage: ALL_PER_PRODUCT,
            })),
          },
          ...rest,
        );
        return {
          results: [
            {
              ...results[0],
              hits: results.flatMap((r: {hits: unknown[]}) => r.hits),
              nbHits: results.reduce((n: number, r: {nbHits?: number}) => n + (r.nbHits ?? 0), 0),
            },
          ],
        };
      }) as typeof client.search;
      return client;
    },
    [docusaurusVersion],
  );

  // Passing transformItems replaces stock's, which makes URLs site-relative; the same processor does that here, plus withNavPath.
  const processUrl = useSearchResultUrlProcessor();
  const transformItems = useCallback(
    (items: DocSearchHit[]): DocSearchHit[] =>
      items.map((item) => withNavPath({...item, url: processUrl(item.url)})),
    [processUrl],
  );

  // The modal is portalled outside our tree, so watch for it mounting.
  const [modal, setModal] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => document.querySelector<HTMLElement>('.DocSearch-Modal');
    const observer = new MutationObserver(() => setModal(find()));
    observer.observe(document.body, {childList: true, subtree: true});
    setModal(find());
    return () => observer.disconnect();
  }, []);

  // Our node inside the modal, portalled into below. `.DocSearch-Modal` is a flex column so it becomes a row unaided;
  // React may displace unknown nodes when swapping screens, so the observer restores it.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!modal) {
      setHost(null);
      return undefined;
    }
    const div = document.createElement('div');
    div.className = styles.host!;
    const place = () => {
      const bar = modal.querySelector('.DocSearch-SearchBar');
      if (bar && div.previousElementSibling !== bar) {
        bar.after(div);
      }
    };
    place();
    setHost(div);
    const observer = new MutationObserver(place);
    observer.observe(modal, {childList: true});
    return () => {
      observer.disconnect();
      div.remove();
    };
  }, [modal]);

  // Mirror the typed query for the Ask AI label; listens rather than controls, as DocSearch owns the input.
  // The listener is on `document`, not the input: React's onChange listens on the body, and a listener on the input
  // runs first. Chrome flushes our setState in a microtask before onChange fires, so React resets the controlled
  // input to its old value and the keystroke is lost. `document` is reached after React's handler has run.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const input = modal?.querySelector<HTMLInputElement>('.DocSearch-Input');
    if (!input) {
      setQuery('');
      return undefined;
    }
    const sync = (event?: Event) => {
      if (event && event.target !== input) return;
      setQuery(input.value);
    };
    sync();
    document.addEventListener('input', sync);
    return () => document.removeEventListener('input', sync);
  }, [modal]);

  // Hand the query to Kapa and close the search modal. Reads the DOM input, not `query`, so it is current at click time.
  // Escape is the only way to close (no imperative API). Both `key` and `code` are set: autocomplete-core reads `key`,
  // useDocSearchKeyboardEvents (which closes the modal) reads `code`.
  const onAskAi = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('.DocSearch-Input');
    const current = input?.value ?? '';
    pushDataLayer('search_ask_ai_click', {
      search_provider: 'algolia',
      search_term: current,
      search_component: selected ?? ALL_COMPONENTS,
    });
    window.Kapa?.('open', current ? {query: current} : undefined);
    input?.dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}),
    );
  }, [selected]);

  // search_performed: debounced (2+ chars, 700ms) and de-duplicated to stay comparable with the legacy site.
  // Count is of rendered hits (post-cap).
  const lastReported = useRef('');
  useEffect(() => {
    if (query.trim().length < 2) {
      lastReported.current = '';
      return undefined;
    }
    const timer = setTimeout(() => {
      if (query === lastReported.current) {
        return;
      }
      lastReported.current = query;
      pushDataLayer('search_performed', {
        search_provider: 'algolia',
        search_term: query,
        search_results_count: document.querySelectorAll('.DocSearch-Hit').length,
        search_component: selected ?? ALL_COMPONENTS,
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [query, selected]);

  // search_result_click: delegated on the modal in the capture phase, so it runs before DocSearch navigates away.
  useEffect(() => {
    if (!modal) {
      return undefined;
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>('.DocSearch-Hit a');
      if (!link) {
        return;
      }
      const links = [...modal.querySelectorAll('.DocSearch-Hit a')];
      pushDataLayer('search_result_click', {
        search_provider: 'algolia',
        search_term:
          document.querySelector<HTMLInputElement>('.DocSearch-Input')?.value ?? '',
        link_url: link.getAttribute('href'),
        link_position: links.indexOf(link) + 1,
        search_component: selected ?? ALL_COMPONENTS,
      });
    };
    modal.addEventListener('click', onClick, true);
    return () => modal.removeEventListener('click', onClick, true);
  }, [modal, selected]);

  return (
    <>
      <SearchBar
        {...props}
        searchParameters={searchParameters}
        transformItems={transformItems}
        transformSearchClient={transformSearchClient}
        maxResultsPerGroup={HITS_PER_PAGE}
      />
      {host &&
        createPortal(
          <ProductFilters
            selected={selected}
            onSelect={onSelect}
            query={query}
            onAskAi={onAskAi}
          />,
          host,
        )}
    </>
  );
}
