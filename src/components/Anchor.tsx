import React from 'react';
import useBrokenLinks from '@docusaurus/useBrokenLinks';

// Inline link target that is not a heading (Markdown has no syntax for one).
// Registers with `collectAnchor` because Docusaurus's broken-anchor check only knows registered
// anchors; a bare `<span id>` works at runtime but is reported as broken.
// An empty span, not `<a>`, to avoid link styling and tab focus.
export default function Anchor({id}: {id: string}): React.ReactElement {
  useBrokenLinks().collectAnchor(id);
  return <span id={id} />;
}
