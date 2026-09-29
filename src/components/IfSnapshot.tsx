import React from 'react';
import useIsSnapshot from '@site/src/components/useIsSnapshot';

// Snapshot-only content (AsciiDoc `ifdef::snapshot[]`), shown only on the unreleased docs version. See <IfNotSnapshot>.
export default function IfSnapshot({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  return useIsSnapshot() ? <>{children}</> : null;
}
