import React, {useEffect, useMemo} from 'react';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import {useHistory, useLocation} from '@docusaurus/router';
import {useColorMode, useThemeConfig} from '@docusaurus/theme-common';

// MUST stay above the `redoc` import: redoc's bundle needs a real global Prism when its module factory runs. Sorting this below it crashes every API page.
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
// Specs bundled at build time by plugins/openapi-specs, so no YAML parsing in the browser. Content-addressed: identical specs across versions are stored once.
import bundledSpecs from '@generated/openapi-specs/default/specs.json';
import {anchorFor} from './anchors';
import {titleFor} from './title';
import {ApiItems} from './Operation';
import {usePublishApiToc} from './apiToc';
import {redocTheme} from './theme';
import styles from './styles.module.css';

// Global class (not a CSS-module hash) because it travels as raw HTML inside a TOC entry's value; styled in styles.module.css.
const TOC_METHOD_CLASS = 'api-toc-method';

// Redoc's <Redoc> is ApiInfo + ContentItems inside a sticky sidebar; composing them without it puts the content in the docs column and the operations in the page TOC.
// Redoc's search box goes with the sidebar; the site's search covers these pages.

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One TOC entry per menu item, keyed by the heading's anchor. Levels are capped at 3 (the theme's default maxHeadingLevel) or entries would vanish.
// The theme renders a TOC `value` as HTML, hence the method badge; the label is escaped since it comes from the spec.
// Labels come from ./title, not Redoc's `sidebarLabel`, which carries the truncated fallback.
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

// The advertised anchor for a deep link that used an older name: the JSON pointer of the operation's spec node (`#/paths/~1rest~1…/post`),
// or Redoc's own id (`#tag/Data-Controller/operation/clearMap`). Matched off the menu item so Redoc's id rules stay its business.
// Returns null when the hash is already the advertised anchor.
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

  // Redoc's scroll and history services are wired up here since <Redoc> isn't rendered.
  // An older-name hash is rewritten to the advertised anchor with `replace` (a synonym, not a place to go back to), through the router's history:
  // raw window.history would leave React Router holding the old hash. The deep link is followed explicitly because Docusaurus's router ran before the
  // operations existed and Redoc's history service doesn't know our anchors. `scroll-margin` on headings clears the sticky navbar.
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
    // Keyed to the store alone: this follows the deep link the page opened with; re-running on location change would drag the reader back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // Hand the operations to the TOC column, and clear them on unmount.
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
            {/* Redoc's download link is hidden in styles.module.css and replaced with a HIVE Button. */}
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
      // Read from live CSS custom properties, so recomputed on colour mode change.
      theme: redocTheme(prismTheme.plain),
      // Redoc scrolls deep links to the viewport top, behind the sticky navbar; measured so it tracks navbar height.
      scrollYOffset: () => document.querySelector('.navbar')?.clientHeight ?? 0,
      // The sidebar's search box is not rendered, so its index is dead weight.
      disableSearch: true,
    }),
    [colorMode, prismTheme],
  );

  // Store is built in the first client render (spec is bundled); memoised so toggling light/dark rebuilds from the same spec.
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

  // Only reachable if the build could not parse the spec (reported at build time).
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
