import React, {useEffect, useMemo} from 'react';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import {useHistory, useLocation} from '@docusaurus/router';
import {useColorMode, useThemeConfig} from '@docusaurus/theme-common';

// MUST stay above the `redoc` import: redoc's bundle needs a real global Prism
// in place when its module factory runs, and this is what puts one there. Import
// order is evaluation order, so moving or sorting this line below the next one
// crashes every API page -- see the module for what the failure looks like.
import './prism-global';
import {
  ApiInfo,
  AppStore,
  OptionsProvider,
  StoreProvider,
  ThemeProvider,
} from 'redoc';
import type {TOCItem} from '@docusaurus/mdx-loader';
import type {PrismTheme} from 'prism-react-renderer';

import {Button} from '@hazelcast/ui/lib/components/Button';

import {specUrlFor} from '@site/plugins/lib/api-spec-url';
// Every spec this site publishes, already bundled ($refs resolved) at build time
// by plugins/openapi-specs. Imported rather than fetched: parsing YAML in the
// browser on every visit was the bulk of the wait between the page appearing and
// the reference appearing in it, and it bought nothing — the build had already
// done that parse to register the operation anchors. This module is only reached
// through Renderer, which BrowserOnly pulls in lazily, so it rides in that chunk
// and costs the rest of the site nothing.
//
// Content-addressed: a spec that several versions publish unchanged is stored
// once and pointed at by each of their URLs.
import bundledSpecs from '@generated/openapi-specs/default/specs.json';
import {anchorFor} from './anchors';
import {titleFor} from './title';
import {ApiItems} from './Operation';
import {usePublishApiToc} from './apiToc';
import {redocTheme} from './theme';
import styles from './styles.module.css';

// Global (not a CSS-module hash) because it travels as raw HTML inside a TOC
// entry's value, where a hashed class name could not be applied. Styled by the
// :global rule in styles.module.css, which is loaded whenever this is.
const TOC_METHOD_CLASS = 'api-toc-method';

// Redoc's own <Redoc> is ApiInfo + ContentItems wrapped in a sticky sidebar that
// takes over the page. Composing the same two pieces WITHOUT that sidebar is the
// whole trick here: the API content drops into the ordinary docs column, the
// site's own sidebar stays where it is, and the operations reach the reader
// through the page's normal table of contents instead of a second nav.
//
// Redoc's search box goes with the sidebar. That is the one deliberate loss —
// the site's own search covers these pages, and keeping Redoc's would mean
// keeping the chrome that motivated dropping it.

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One TOC entry per menu item, in document order, keyed by the anchor its
// heading carries (see ./anchors) — so an entry needs no anchor of its own and
// Docusaurus's TOC highlighting finds it by id like any heading. It is the same
// id the hash-link on that heading copies, so the TOC and the heading hand the
// reader the same link. Levels are capped at 3 because that is where the theme's default
// maxHeadingLevel cuts off, and an entry below the cut would silently vanish.
//
// An operation is prefixed with its HTTP method, as Redoc's own menu shows it.
// A TOC entry's `value` is rendered as HTML by the theme (TOCItems/Tree), which
// is what makes the badge possible; the label itself is escaped, since it comes
// from the spec. The method colour is read off the resolved theme rather than
// restated, so a badge here and the same badge in the content cannot diverge.
//
// The label comes from ./title, the same helper the heading uses -- not from
// Redoc's `sidebarLabel`, which is its `name` verbatim (checked for both menu
// models) and so carried the truncated fallback into the TOC as well. Deriving
// both from one helper is what makes a TOC entry and the heading it points at
// provably the same string.
function tocItemsFor(store: AppStore): TOCItem[] {
  const httpColors = (store.options.theme.colors as {http?: Record<string, string>}).http ?? {};
  const items: TOCItem[] = [];
  const walk = (menuItems: readonly any[], level: number) => {
    for (const item of menuItems) {
      const label = escapeHtml(titleFor(item).title);
      const verb: string | undefined = item.type === 'operation' ? item.httpVerb : undefined;
      const value = verb
        ? `<span class="${TOC_METHOD_CLASS}" style="color:${httpColors[verb.toLowerCase()] ?? 'inherit'}">` +
          `${escapeHtml(verb)}</span>${label}`
        : label;
      items.push({id: anchorFor(item), value, level: Math.min(level, 3)});
      if (item.items?.length) {
        walk(item.items, level + 1);
      }
    }
  };
  walk(store.menu.items, 2);
  return items;
}

// The anchor this page ADVERTISES for whatever a deep link asked for, when the
// link asked by one of the older names the same operation also answers to.
//
// There are two such names, and the corpus links by both:
//
//   #/paths/~1rest~1clusters~1%7Bcluster%7D~1clientfiltering~1lists/post
//     the JSON POINTER of the operation's spec node — the form the old site
//     published where a spec gave no operationId, so it is what got copy-pasted
//     into the AsciiDoc sources and what any inbound link out there carries;
//   #tag/Data-Controller/operation/clearMap
//     Redoc's own id, which is what it anchors an operation by when the spec DOES
//     give an operationId (Platform's gives one for all 50).
//
// Both are matched off the menu item rather than rebuilt from path + verb, so
// Redoc's id-making rules stay Redoc's business — and an operation whose id is
// itself pointer-shaped is covered by the same lookup.
//
// Returns null when the hash is already the advertised anchor, which is every
// ordinary link into this page.
function advertisedAnchorFor(store: AppStore, hash: string): string | null {
  if (!hash) {
    return null;
  }
  const match = (store.menu.flatItems as readonly any[]).find(
    (item) => item.id === hash || String(item.pointer ?? '').replace(/^#/, '') === hash,
  );
  if (!match) {
    return null;
  }
  const anchor = anchorFor(match);
  return anchor === hash ? null : anchor;
}

const currentHash = (): string => {
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch {
    return window.location.hash.replace(/^#/, ''); // malformed percent-encoding: use it raw
  }
};

function ApiContent({store, specUrl}: {store: AppStore; specUrl: string}): React.ReactElement {
  const publish = usePublishApiToc();
  const history = useHistory();
  const location = useLocation();

  // Redoc's scroll and history services are wired up here rather than by its own
  // <Redoc>, which we are not rendering. Without them a #operation/… deep link
  // does not scroll on load.
  //
  //
  // A hash written as one of the older names is rewritten to the anchor the page
  // advertises, so the reader is left on a URL they can copy. `replace`, not a
  // push: the old hash is a synonym for this one, not a place to go back to. The
  // element itself carries BOTH ids, so the scroll below works either way — this
  // is about what the reader ends up with in the address bar. Through the ROUTER's
  // history rather than window.history — the raw DOM call changes the address bar
  // without telling React Router, which still holds the location it navigated to
  // and puts the old hash back at its next render.
  //
  // Then the deep link is followed here, explicitly. It cannot be left to either
  // of the two things that would normally do it: Docusaurus's router tried on
  // navigation, long before the spec had loaded and the operations existed, and
  // Redoc's own history service only recognises ids of its own making, which the
  // published anchors deliberately are not. This effect runs after the commit
  // that put the operations in the DOM, so the element is there. `scroll-margin`
  // from the heading's `anchor` class keeps it clear of the sticky navbar.
  useEffect(() => {
    store.onDidMount();
    const hash = currentHash();
    const anchor = advertisedAnchorFor(store, hash) ?? hash;
    if (anchor !== hash) {
      history.replace({...location, hash: anchor});
    }
    if (anchor) {
      document.getElementById(anchor)?.scrollIntoView();
    }
    return () => store.dispose();
    // Deliberately keyed to the store alone: this follows the deep link the page
    // was OPENED with, and re-running it when the location changes would drag the
    // reader back after they navigate away within the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // Hand the operations to the TOC column, and take them back on the way out so
  // the next page does not inherit them.
  useEffect(() => {
    publish(tocItemsFor(store));
    return () => publish([]);
  }, [store, publish]);

  return (
    <ThemeProvider theme={store.options.theme}>
      <StoreProvider value={store}>
        <OptionsProvider value={store.options}>
          <div className={styles.apiReference}>
            <ApiInfo store={store} />
            {/* Redoc's own download link is hidden by styles.module.css and
                replaced here with a real HIVE Button, so the one call to action
                on the page matches every other button on the site. It points at
                the same published attachment URL Redoc's link used. */}
            <div className={styles.download}>
              <Button component="a" href={specUrl} variant="outlined" color="primary">
                Download OpenAPI specification
              </Button>
            </div>
            <ApiItems items={store.menu.items} />
          </div>
        </OptionsProvider>
      </StoreProvider>
    </ThemeProvider>
  );
}

export default function Renderer({source}: {source: string}): React.ReactElement {
  const active = useActivePluginAndVersion();
  const {colorMode} = useColorMode();
  const {prism} = useThemeConfig();
  const prismTheme = (colorMode === 'dark' ? prism.darkTheme : prism.theme) as PrismTheme;
  const specUrl = specUrlFor(active?.activeVersion?.path ?? '', source);

  const options = useMemo(
    () => ({
      // Colours are read from the page's live CSS custom properties, so this is
      // recomputed when the colour mode changes rather than parameterised by it.
      theme: redocTheme(prismTheme.plain),
      // Redoc scrolls a deep-linked operation to the top of the viewport, which
      // puts it behind the sticky navbar. Measured rather than hardcoded so it
      // stays right if the navbar's height changes.
      scrollYOffset: () => document.querySelector('.navbar')?.clientHeight ?? 0,
      // The sidebar's search box is not rendered, so its index is dead weight.
      disableSearch: true,
    }),
    [colorMode, prismTheme],
  );

  // The spec is already in hand, so the store is built during the FIRST client
  // render — there is no loading state to pass through and no second render to
  // wait for. Memoised so that toggling light/dark rebuilds it from the same
  // spec rather than starting over.
  const {specs, specHashByUrl} = bundledSpecs as {
    specs: Record<string, object>;
    specHashByUrl: Record<string, string>;
  };
  const spec = specs[specHashByUrl[specUrl]!];
  const store = useMemo(
    // `false` is createSearchIndex: nothing renders the search box.
    () => (spec ? new AppStore(spec as any, specUrl, options, false) : null),
    [spec, specUrl, options],
  );

  // Only reachable if the build could not parse the spec, which it reports at
  // build time. The published attachment is still the reader's way to it.
  if (!store) {
    return (
      <div className={styles.placeholder}>
        This API reference could not be loaded. The specification is published at{' '}
        <a href={specUrl}>{specUrl}</a>.
      </div>
    );
  }
  return <ApiContent store={store} specUrl={specUrl} />;
}
