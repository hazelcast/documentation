import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {usePluginData} from '@docusaurus/useGlobalData';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';

import {specUrlFor} from '@site/plugins/lib/api-spec-url';
import styles from './styles.module.css';

// Renders the OpenAPI spec a page declares. `source` is the upstream GitHub blob URL, with the branch as an {attribute} reference.
// The spec is staged at build time by plugins/openapi-specs; this only derives the staged URL (plugins/lib/api-spec-url.js, shared so they agree).
// Renderer stays behind BrowserOnly: the theme is resolved from live CSS custom properties via canvas (theme.ts), and this keeps its bundle off other pages.

// Register the page's operation anchors with Docusaurus. This must render on the server: SSR is the only time useBrokenLinks().collectAnchor is honoured,
// and the operations themselves only exist in the browser. Without it every link into an API page reports as a broken anchor, typos included.
function useOperationAnchors(source: string): void {
  const brokenLinks = useBrokenLinks();
  // Read defensively, not destructured: the anchors only enable link validation, and missing plugin data (e.g. a stale dev server) must not blank the page.
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
