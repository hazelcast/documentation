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
import styles from './styles.module.css';

type Props = WrapperProps<typeof SearchBarType>;

// The products, and the Algolia facet value each one selects.
//
// These are the ANTORA index's shape, not this site's: `prod_hazelcast_docs` is
// still the index the Antora site's scraper builds, and the only attribute it
// declares facetable is `tags` (`attributesForFaceting: ["searchable(tags)"]`),
// whose values are `<component>` or `<component>-<version>`. The site's own
// `docusaurus_tag` is not in there at all — which is also why `contextualSearch`
// is off in docusaurus.config.ts.
//
// Naming the LATEST release per product is what keeps old versions out of the
// results: the index holds every version the Antora site publishes, so "All"
// below is an OR over exactly these six and nothing older can surface.
//
// When the index is re-crawled from this site, this table is the thing to
// change: `tags` becomes whatever stable per-product attribute the crawler's
// recordExtractor writes, and the version suffixes disappear with it.
const PRODUCTS = [
  {id: 'hazelcast', label: 'Platform', tag: 'hazelcast-5.7'},
  {id: 'cloud', label: 'Cloud', tag: 'cloud'},
  {id: 'management-center', label: 'Management Center', tag: 'management-center-5.11'},
  {id: 'operator', label: 'Operator', tag: 'operator-5.18'},
  {id: 'clc', label: 'CLC', tag: 'clc-5.5.1'},
  {id: 'tutorials', label: 'Tutorials', tag: 'tutorials'},
] as const;

const ALL_TAGS = PRODUCTS.map(({tag}) => `tags:${tag}`);

// An Algolia facetFilters value: the outer array ANDs, a nested array ORs. One
// nested element, so selecting nothing ORs every product and selecting one
// narrows to it.
const filtersFor = (id: string | null): string[] =>
  id ? [`tags:${PRODUCTS.find((p) => p.id === id)!.tag}`] : ALL_TAGS;

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
          Results come from the latest released version of each product.
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
  // A deeper pool gets every product into the running; the per-group cap (DocSearch
  // sets none of its own) stops Platform filling the panel again once it is there.
  const searchParameters = useRef({facetFilters, hitsPerPage: 60}).current;
  const [selected, setSelected] = useState<string | null>(null);

  const onSelect = useCallback(
    (id: string | null) => {
      setSelected(id);
      facetFilters[0] = filtersFor(id);
      requery();
    },
    [facetFilters],
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
    window.Kapa?.('open', current ? {query: current} : undefined);
    input?.dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}),
    );
  }, []);

  return (
    <>
      <SearchBar {...props} searchParameters={searchParameters} maxResultsPerGroup={4} />
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
