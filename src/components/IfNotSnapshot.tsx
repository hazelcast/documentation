import React from 'react';
import useIsSnapshot from '@site/src/components/useIsSnapshot';

// Release-only content (AsciiDoc `ifndef::snapshot[]`): hidden on the unreleased version, the else half of <IfSnapshot>.
// Lets `docs:version` copy pages verbatim and still flip correctly.
export default function IfNotSnapshot({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  return useIsSnapshot() ? null : <>{children}</>;
}
