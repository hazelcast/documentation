import React, {type ReactNode} from 'react';

// The callout list that explains an annotated code block's `<N>` markers.
//
// Authors write a plain Markdown numbered list inside <CodeCallouts>:
//
//   <CodeCallouts>
//   1. Cluster recovery policy.
//   2. Size of the PVC.
//   </CodeCallouts>
//
// Each item renders with the same circled callout badge (`.conum`) as the
// in-code markers, indented from the body via `.conum-list` (src/css/custom.css).
// The number is emitted as real text in <b> (styled away, shown as the circle),
// so it reads as "1 Cluster recovery policy." — matching Asciidoctor's colist,
// which is a table (not a list), so we deliberately render no top-level <li>.
// Registered globally in src/theme/MDXComponents.tsx: no import needed in MDX.

function calloutItems(children: ReactNode): React.ReactElement[] {
  const top = React.Children.toArray(children).filter(React.isValidElement);
  // The list is the single <ol> child (Markdown `1.` items); use its <li>s.
  const ol = top.find((c) => (c as React.ReactElement).type === 'ol') as
    | React.ReactElement
    | undefined;
  const source = ol ? ol.props.children : children;
  return React.Children.toArray(source).filter(
    React.isValidElement,
  ) as React.ReactElement[];
}

// A loose Markdown list wraps each item's content in a <p>. Unwrap a leading <p>
// so the number and the item's first line render on ONE line next to the badge
// (any further blocks — a nested list — follow after). This matches how the
// golden colist reads the row and keeps the fidelity text compare aligned.
function itemContent(li: React.ReactElement): ReactNode[] {
  // Drop whitespace-only text nodes first — a loose item's children begin with a
  // "\n" node, which would otherwise hide the leading <p>.
  const kids = React.Children.toArray(li.props.children).filter(
    (k) => React.isValidElement(k) || (typeof k === 'string' && k.trim() !== ''),
  );
  if (kids.length && React.isValidElement(kids[0]) && kids[0].type === 'p') {
    return [
      ...React.Children.toArray((kids[0] as React.ReactElement).props.children),
      ...kids.slice(1),
    ];
  }
  return kids;
}

export default function CodeCallouts({children}: {children: ReactNode}) {
  return (
    <div className="conum-list">
      {calloutItems(children).map((li, i) => (
        <div className="conum-item" key={i}>
          <i className="conum" data-value={i + 1} />
          <b>{i + 1}</b>
          {' '}
          {itemContent(li)}
        </div>
      ))}
    </div>
  );
}
