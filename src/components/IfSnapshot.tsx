import React from 'react';
import useIsSnapshot from '@site/src/components/useIsSnapshot';

// Renders snapshot-only content (from AsciiDoc `ifdef::snapshot[]`) only on the
// unreleased/snapshot docs version, so it hides automatically once a release is
// cut from those docs (`docusaurus docs:version` copies the file verbatim, but the
// cut version is no longer 'unreleased'). See <IfNotSnapshot> for the else half,
// and useIsSnapshot for the shared version test.
export default function IfSnapshot({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  return useIsSnapshot() ? <>{children}</> : null;
}
