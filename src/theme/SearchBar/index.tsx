// Search — DocSearch, plus a product filter bar injected into its modal.
//
// The bar is not something DocSearch supports: v4's modal exposes only
// `hitComponent`, `resultsFooterComponent`, `transformItems`, `searchParameters`,
// `translations`, `askAi`, `indices` and `maxResultsPerGroup` — no header slot.
// So the buttons are portalled into a div we insert ourselves, and the re-query
// is driven by two deliberate pieces of knowledge about DocSearch's internals,
// both documented at their use site below. Both were read off @docsearch/react
// 4.6.3; re-check them when that version moves (it arrives transitively through
// preset-classic -> theme-search-algolia, whose range is `^3.9.0 || ^4.3.2`, so
// what moves it is a DOCUSAURUS upgrade, not a DocSearch one).
//
// This is a WRAPPER, not an eject: the stock SearchBar is a thin shell that
// forwards props to DocSearch, which is enough for everything here.
import React, {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import clsx from 'clsx';
import SearchBar from '@theme-original/SearchBar';
import {Button} from '@hazelcast/ui/lib/components/Button';
import {ButtonGroup} from '@hazelcast/ui/lib/components/ButtonGroup';
import AskAiIcon from '@site/src/components/NavbarAskAi/AskAiIcon';
import type SearchBarType from '@theme/SearchBar';
import type {WrapperProps} from '@docusaurus/types';
import type {DocSearchHit} from '@docsearch/react';
import {useSearchResultUrlProcessor} from '@docusaurus/theme-search-algolia/client';
import {pushDataLayer} from '@site/src/lib/analytics';
import styles from './styles.module.css';

type Props = WrapperProps<typeof SearchBarType>;

// The products the filter bar offers. Each `id` is a value of the index's
// `product` facet, which the crawler writes onto every record from the docs
// plugin the page belongs to — so it carries no version. The index holds only
// the latest release of each product (the crawler's URL patterns decide which),
// so nothing here changes when a version is cut.
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

// What `search_component` carries when no product filter is applied. The string
// is the Antora build's, so the two sites report into the same value space.
const ALL_COMPONENTS = 'All';

// An Algolia facetFilters value: the outer array ANDs, a nested array ORs. One
// nested element, so selecting nothing ORs every product and selecting one
// narrows to it.
const filtersFor = (id: string | null): string[] => (id ? [`product:${id}`] : ALL_PRODUCTS);

// How many hits each product shows under "All". A single product is uncapped.
const ALL_PER_PRODUCT = 4;

const HITS_PER_PAGE = 60;

// DocSearch's own list of attributes to fetch, plus the crawler's `breadcrumb`.
// Passing any `attributesToRetrieve` replaces DocSearch's default rather than
// adding to it, so its list is repeated here (read off @docsearch/react 4.6.3).
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

// The grey line under a section or content hit, as the page's place in the nav
// ("Operate and manage › Maintaining a cluster › Monitoring") rather than
// DocSearch's page title alone. `breadcrumb` is the page's breadcrumb bar,
// which the crawler records on every record.
//
// DocSearch renders that line from `_snippetResult.hierarchy.lvl1.value` (as
// HTML, falling back to the raw `hierarchy.lvl1`), so the path is written there,
// escaped. Page-level hits keep their own line: for them lvl1 is the title and
// the line is a content snippet.
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

// Re-run the current query after the filters change.
//
// DocSearch builds its autocomplete instance once, behind a `useRef` guard, and
// does not expose the `refresh()` it gets back — so there is no supported way to
// ask it to search again. Dispatching a native `input` event on its own input is
// the way in: React listens for 'input', so this reaches autocomplete's onChange
// exactly as a keystroke would, with the query unchanged.
function requery(): void {
  const input = document.querySelector<HTMLInputElement>('.DocSearch-Input');
  if (!input) return;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setValue?.call(input, input.value);
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
    // A real HIVE ButtonGroup: it is the segmented control the design system
    // already has for a set of mutually exclusive choices, and it renders its own
    // role="group" and aria-label. The scroll wrapper is ours -- the group is
    // `inline-flex` with no wrapping, and seven labels overrun the modal's width.
    <div className={styles.bar}>
      <div className={styles.filters}>
        <ButtonGroup ariaLabel="Filter results by product">
          {[{id: null, label: 'All'}, ...PRODUCTS].map(({id, label}) => (
            <Button
              key={id ?? 'all'}
              type="button"
              // HIVE's own `active` is a faint grey fill on an outlined button --
              // too quiet for the one control that says what you are searching.
              // The filled variant is the same design system, read at a glance.
              variant={selected === id ? 'contained' : 'outlined'}
              active={selected === id}
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
        {/* Hands the typed query straight to Kapa, so the reader does not retype
            it. Naming the query in the label is what makes that legible. */}
        <Button
          type="button"
          variant="outlined"
          iconLeft={AskAiIcon}
          iconLeftAriaLabel="Ask AI"
          truncate
          className={clsx(styles.outlined, styles.askAi)}
          onClick={onAskAi}>
          {query ? `Ask AI about "${query}"` : 'Ask AI'}
        </Button>
      </div>
    </div>
  );
}

export default function SearchBarWrapper(props: Props): ReactNode {
  // The array DocSearch reads its facet filters from, and the reason this whole
  // approach works without remounting the modal.
  //
  // DocSearch captures `searchParameters` ONCE, when the autocomplete instance is
  // built, so replacing the prop later is silently ignored. But what it captured
  // is a REFERENCE, and it dereferences `.facetFilters` at query time, spreading
  // it into the request. So mutating this array in place changes the next query,
  // and the modal never has to be torn down.
  //
  // Held in a ref, not state: its identity has to survive every render, and it is
  // deliberately not what drives the re-render (`selected` is).
  const facetFilters = useRef<string[][]>([filtersFor(null)]).current;

  // Why these two numbers.
  //
  // DocSearch asks for 20 hits and groups what comes back by product. Platform is
  // most of the corpus, so on an unfiltered query it takes nearly the whole pool
  // and the smaller products show one hit or none -- which reads as "Cloud has
  // nothing about this" when filtering to Cloud plainly shows otherwise.
  //
  // A deeper pool gets every product into the running; the per-product cap in
  // transformItems below stops Platform filling the panel again once it is there.
  const searchParameters = useRef({
    facetFilters,
    hitsPerPage: HITS_PER_PAGE,
    attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
  }).current;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const onSelect = useCallback(
    (id: string | null) => {
      setSelected(id);
      selectedRef.current = id;
      facetFilters[0] = filtersFor(id);
      requery();
    },
    [facetFilters],
  );

  // The per-product cap, applied only under "All".
  //
  // DocSearch's own `maxResultsPerGroup` cannot do this: it is a number captured
  // when the modal first opens, so it would cap a single product too. Instead it
  // is set to the whole pool, and this does the capping. DocSearch runs
  // transformItems on the hits BEFORE grouping them by `hierarchy.lvl0` (the
  // product name, per the crawler), and it too is captured once — hence it reads
  // the selection from a ref at query time rather than closing over `selected`.
  //
  // Passing transformItems replaces the stock one, which makes each hit's URL
  // site-relative (so results open on whatever host is serving the site, not
  // the one the index was crawled from); the same processor does that here. It
  // also rewrites each hit's subtitle to its nav path (withNavPath).
  const processUrl = useSearchResultUrlProcessor();
  const transformItems = useCallback(
    (items: DocSearchHit[]): DocSearchHit[] => {
      const counts = new Map<string, number>();
      return items
        .filter((item) => {
          if (selectedRef.current !== null) return true;
          const group = item.hierarchy.lvl0;
          const n = counts.get(group) ?? 0;
          counts.set(group, n + 1);
          return n < ALL_PER_PRODUCT;
        })
        .map((item) => withNavPath({...item, url: processUrl(item.url)}));
    },
    [processUrl],
  );

  // The modal mounts and unmounts outside our tree (DocSearch portals it into a
  // container of its own), so the only way to know it is on screen is to watch
  // for it.
  const [modal, setModal] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => document.querySelector<HTMLElement>('.DocSearch-Modal');
    const observer = new MutationObserver(() => setModal(find()));
    observer.observe(document.body, {childList: true, subtree: true});
    setModal(find());
    return () => observer.disconnect();
  }, []);

  // Our own node inside the modal, portalled into below.
  //
  // `.DocSearch-Modal` is `flex-direction: column`, so a div dropped between the
  // search bar and the results needs no positioning at all — it just becomes the
  // next row. The catch is that React owns that child list and swaps the dropdown
  // for the Ask AI and no-results screens, which can displace a node it does not
  // know about; the observer puts it back.
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

  // Mirror what has been typed, so the Ask AI label can name it. DocSearch owns
  // the input, so this listens rather than controls; `input` is what React fires
  // for a keystroke and what requery() above dispatches.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const input = modal?.querySelector<HTMLInputElement>('.DocSearch-Input');
    if (!input) {
      setQuery('');
      return undefined;
    }
    const sync = () => setQuery(input.value);
    sync();
    input.addEventListener('input', sync);
    return () => input.removeEventListener('input', sync);
  }, [modal]);

  // Hand the query to Kapa and dismiss the search modal, so the two do not sit
  // open on top of each other.
  //
  // Read off the DOM rather than from `query`: DocSearch owns the input, and this
  // has to send what is in it at the moment of the click even if a keystroke has
  // not round-tripped through state yet.
  //
  // Escape is how the modal closes: DocSearch exposes no imperative close. Both
  // `key` AND `code` are set because two different handlers read the event and
  // they disagree -- autocomplete-core dismisses its results panel on
  // `event.key`, while useDocSearchKeyboardEvents, the window-bound hook that
  // actually closes the MODAL, tests `event.code`. Setting only one leaves the
  // search open behind the Kapa modal.
  //
  // A plain onClick suffices: the strip is INSIDE .DocSearch-Modal, so clicking
  // it is not the outside click that would dismiss the modal by itself.
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

  // search_performed. Debounced and de-duplicated the same way the Antora build
  // reports it, so the two are comparable: at least two characters, 700ms after
  // typing settles, and never the same query twice running. Changing the product
  // filter re-runs this effect but not the event -- the query has not changed.
  //
  // The count is of RENDERED hits, which is what the per-product cap leaves on
  // screen rather than everything Algolia returned.
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

  // search_result_click. Delegated on the modal and bound in the CAPTURE phase,
  // so it runs before DocSearch handles the click and navigates away.
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
