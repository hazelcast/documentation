import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {usePluginData} from '@docusaurus/useGlobalData';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';

import {specUrlFor} from '@site/plugins/lib/api-spec-url';
import styles from './styles.module.css';

// Renders the OpenAPI spec a page declares.
//
//   <ApiReference source="https://github.com/hazelcast/management-center/blob/{mc-repo-swagger-branch}/…/rest-client-api.yaml" />
//
// `source` is the upstream GitHub blob URL, exactly as the AsciiDoc swagger_ui
// macro took it, with the branch left as an {attribute} reference so it resolves
// per version. It is not fetched from here: plugins/openapi-specs resolves the
// same declaration at build time and stages the spec as a static attachment, and
// this component only has to work out the URL it was staged at
// (plugins/lib/api-spec-url.js, shared so the two cannot disagree).
//
// Redoc is not itself SSR-hostile — it builds its store and renders to string
// under plain Node — but two things here are: the spec arrives from an async
// fetch, and the theme is resolved from the page's live CSS custom properties by
// canvas (see theme.ts). So the renderer stays behind BrowserOnly, which also
// keeps its bundle off every other page.

// Register the page's operation anchors with Docusaurus.
//
// This is why the wrapper is a component of its own rather than BrowserOnly at
// the call site: it renders on the SERVER, which is the only time Docusaurus
// collects anchors (useBrokenLinks().collectAnchor, called during the SSR pass —
// nothing scans the rendered HTML for ids). The operations themselves appear
// only in the browser, so without this every link into an API page is reported
// as a broken anchor and, worse, a link with a genuine TYPO in it is reported
// exactly the same way and cannot be told apart.
//
// With it, `onBrokenAnchors` polices links into API pages like links to any
// heading: a contributor who mistypes an operation anchor hears about it from the
// build. The ids come from the plugin, which read them off the staged spec —
// see plugins/lib/api-anchors.js for the shape and why it is method + path.
function useOperationAnchors(source: string): void {
  const brokenLinks = useBrokenLinks();
  // Read defensively rather than destructured. The anchors are an ENHANCEMENT —
  // they make the build validate links into this page — and the page must still
  // render without them. Destructuring threw the whole page into its error
  // boundary the one time the data was missing (a dev server whose plugin had not
  // re-run its lifecycle), turning a lost warning into a blank page.
  const pluginData = usePluginData('openapi-specs') as
    | {anchorsByUrl?: Record<string, string[]>}
    | undefined;
  const activeVersion = useActivePluginAndVersion()?.activeVersion;
  const anchors = pluginData?.anchorsByUrl?.[specUrlFor(activeVersion?.path ?? '', source)] ?? [];
  for (const anchor of anchors) {
    brokenLinks.collectAnchor(anchor);
  }
}

export default function ApiReference({source}: {source: string}): React.ReactElement {
  useOperationAnchors(source);
  return (
    <BrowserOnly fallback={<div className={styles.placeholder}>Loading API reference…</div>}>
      {() => {
        const Renderer = (require('./Renderer') as typeof import('./Renderer')).default;
        return <Renderer source={source} />;
      }}
    </BrowserOnly>
  );
}
