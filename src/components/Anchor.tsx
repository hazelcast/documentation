import React from 'react';
import useBrokenLinks from '@docusaurus/useBrokenLinks';

// An inline link target that is NOT a heading — AsciiDoc's `[[id]]` / `anchor:id[]`,
// which Antora renders as an empty `<a id="…"></a>` mid-content (in a table cell, a
// list item, a step). Docusaurus has no Markdown syntax for one: `{#id}` works only
// on a heading.
//
// A bare `<span id="…">` in MDX renders and resolves in the browser, and that is
// what the converter used to emit — but Docusaurus's broken-anchor validation only
// knows about anchors a component REGISTERS through
// `useBrokenLinks().collectAnchor()` (its own Heading, Details and Li components do
// exactly this). So every link to one was reported by `onBrokenAnchors` even though
// it worked at runtime, and that noise is what would hide a genuinely broken
// anchor. Registering here is the whole reason this component exists.
//
// Renders an empty span rather than an `<a>`: an anchor with no href is not
// interactive, and a real `<a>` would pick up link styling and tab focus.
export default function Anchor({id}: {id: string}): React.ReactElement {
  useBrokenLinks().collectAnchor(id);
  return <span id={id} />;
}
