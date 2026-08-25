import React, {useEffect, useMemo, useState} from 'react';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import {useColorMode, useThemeConfig} from '@docusaurus/theme-common';
import {
  ApiInfo,
  AppStore,
  ContentItems,
  MiddlePanel,
  OptionsProvider,
  Row,
  StoreProvider,
  ThemeProvider,
  loadAndBundleSpec,
} from 'redoc';
import type {TOCItem} from '@docusaurus/mdx-loader';
import type {PrismTheme} from 'prism-react-renderer';

import {Button} from '@hazelcast/ui/lib/components/Button';

import {specUrlFor} from '@site/plugins/lib/api-spec-url';
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

// Redoc highlights its samples with its own copy of prism-dark, baked into a
// styled-component (PrismDiv) and reachable by neither its theme object nor any
// option. Here the samples are ordinary code blocks in the page, so they are
// restyled from the SITE's configured Prism theme — the very object
// @theme/CodeBlock renders with — rather than from a second palette invented
// here. The scope class is doubled to out-specify Redoc's own `.sc-x .token-y`
// rules, which are of equal specificity and would otherwise win on order.
function prismTokenCss(theme: PrismTheme, scope: string): string {
  const at = (selector: string) => `.${scope}.${scope} ${selector}`;
  const rules = [
    `${at(`pre[class*='language-'], .${scope}.${scope} code[class*='language-']`)} {` +
      ` color: ${theme.plain.color ?? 'inherit'}; background: none; text-shadow: none; }`,
  ];
  for (const {types, style} of theme.styles) {
    const declarations = Object.entries(style)
      .filter(([, value]) => value !== undefined)
      .map(([property, value]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value}`);
    if (!declarations.length) {
      continue;
    }
    rules.push(`${types.map((type) => at(`.token.${type}`)).join(', ')} { ${declarations.join('; ')}; }`);
  }
  return rules.join('\n');
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One TOC entry per menu item, in document order. Redoc gives every section and
// operation an `id` and renders it as that element's DOM id, so the entries need
// no anchor of their own — Docusaurus's TOC highlighting finds them by id like
// any heading. Levels are capped at 3 because that is where the theme's default
// maxHeadingLevel cuts off, and an entry below the cut would silently vanish.
//
// An operation is prefixed with its HTTP method, as Redoc's own menu shows it.
// A TOC entry's `value` is rendered as HTML by the theme (TOCItems/Tree), which
// is what makes the badge possible; the label itself is escaped, since it comes
// from the spec. The method colour is read off the resolved theme rather than
// restated, so a badge here and the same badge in the content cannot diverge.
function tocItemsFor(store: AppStore): TOCItem[] {
  const httpColors = (store.options.theme.colors as {http?: Record<string, string>}).http ?? {};
  const items: TOCItem[] = [];
  const walk = (menuItems: readonly any[], level: number) => {
    for (const item of menuItems) {
      const label = escapeHtml(item.sidebarLabel || item.name);
      const verb: string | undefined = item.type === 'operation' ? item.httpVerb : undefined;
      const value = verb
        ? `<span class="${TOC_METHOD_CLASS}" style="color:${httpColors[verb.toLowerCase()] ?? 'inherit'}">` +
          `${escapeHtml(verb)}</span>${label}`
        : label;
      items.push({id: item.id, value, level: Math.min(level, 3)});
      if (item.items?.length) {
        walk(item.items, level + 1);
      }
    }
  };
  walk(store.menu.items, 2);
  return items;
}

function ApiContent({
  store,
  specUrl,
  prismTheme,
}: {
  store: AppStore;
  specUrl: string;
  prismTheme: PrismTheme;
}): React.ReactElement {
  const publish = usePublishApiToc();

  // Redoc's scroll and history services are wired up here rather than by its own
  // <Redoc>, which we are not rendering. Without them a #operation/… deep link
  // does not scroll on load.
  useEffect(() => {
    store.onDidMount();
    return () => store.dispose();
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
            <style>{prismTokenCss(prismTheme, styles.apiReference!)}</style>
            <ApiInfo store={store} />
            {/* Redoc's own download link is hidden by styles.module.css and
                replaced here with a real HIVE Button, so the one call to action
                on the page matches every other button on the site. It points at
                the same published attachment URL Redoc's link used, and goes in
                Redoc's own Row/MiddlePanel so it lines up with the content
                above it rather than against the container edge. */}
            <Row>
              <MiddlePanel className={styles.download}>
                <Button component="a" href={specUrl} variant="outlined" color="primary">
                  Download OpenAPI specification
                </Button>
              </MiddlePanel>
            </Row>
            <ContentItems items={store.menu.items as any} />
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

  const [spec, setSpec] = useState<object | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Split from the store below so that toggling light/dark rebuilds the store
  // from the spec already in hand instead of fetching it again.
  useEffect(() => {
    let cancelled = false;
    setSpec(null);
    setError(null);
    loadAndBundleSpec(specUrl).then(
      (resolved) => !cancelled && setSpec(resolved),
      (cause) => !cancelled && setError(cause instanceof Error ? cause : new Error(String(cause))),
    );
    return () => {
      cancelled = true;
    };
  }, [specUrl]);

  const store = useMemo(
    // `false` is createSearchIndex: nothing renders the search box.
    () => (spec ? new AppStore(spec as any, specUrl, options, false) : null),
    [spec, specUrl, options],
  );

  if (error) {
    return (
      <div className={styles.placeholder}>
        This API reference could not be loaded. The specification is published at{' '}
        <a href={specUrl}>{specUrl}</a>.
      </div>
    );
  }
  if (!store) {
    return <div className={styles.placeholder}>Loading API reference…</div>;
  }
  return <ApiContent store={store} specUrl={specUrl} prismTheme={prismTheme} />;
}
