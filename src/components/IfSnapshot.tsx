import React from 'react';
import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';

// Renders snapshot-only content (from AsciiDoc `ifdef::snapshot[]`) only on the
// unreleased/snapshot docs version. Docusaurus tags the version newer than the
// configured `lastVersion` with banner 'unreleased'; released versions get
// 'none' or 'unmaintained'. So content wrapped here shows on the current
// snapshot docs and hides automatically once a release is cut from them
// (`docusaurus docs:version` copies the file verbatim, but the cut version is no
// longer 'unreleased') — which is why the converter can safely emit it in the
// current tree without baking it per version.
export default function IfSnapshot({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  const {banner} = useDocsVersion();
  return banner === 'unreleased' ? <>{children}</> : null;
}
