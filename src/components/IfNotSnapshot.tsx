import React from 'react';
import useIsSnapshot from '@site/src/components/useIsSnapshot';

// Renders release-only content (from AsciiDoc `ifndef::snapshot[]`) on every docs
// version EXCEPT the unreleased/snapshot one — the else half of <IfSnapshot>.
//
// The point is the version cut: `docusaurus docs:version` copies the current
// (snapshot) tree verbatim, so a page that carries both branches needs no edit to
// come out right. On the snapshot docs this content is hidden and the <IfSnapshot>
// branch shows; the moment the copy becomes a released version that reverses,
// exactly as Antora's per-branch `snapshot` attribute did.
export default function IfNotSnapshot({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  return useIsSnapshot() ? null : <>{children}</>;
}
