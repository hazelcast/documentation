import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

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
// Redoc is SSR-unsafe — it reaches for window as it builds its store — so the
// whole renderer is behind BrowserOnly and pulled in lazily, which also keeps
// its bundle off every other page.
export default function ApiReference({source}: {source: string}): React.ReactElement {
  return (
    <BrowserOnly fallback={<div className={styles.placeholder}>Loading API reference…</div>}>
      {() => {
        const Renderer = (require('./Renderer') as typeof import('./Renderer')).default;
        return <Renderer source={source} />;
      }}
    </BrowserOnly>
  );
}
