import React, {type ReactNode} from 'react';

// Callout list for an annotated code block's `<N>` markers: a Markdown numbered list inside <CodeCallouts>,
// each item shown with the circled `.conum` badge (src/css/custom.css). No top-level <li> is rendered.
// Registered globally in src/theme/MDXComponents.tsx.

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

// Unwrap the leading <p> of a loose list item so the number and first line sit on one line beside the badge.
function itemContent(li: React.ReactElement): ReactNode[] {
  // Drop whitespace-only text nodes first: a loose item starts with a "\n" node that would hide the leading <p>.
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
