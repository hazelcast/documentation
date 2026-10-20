import React from 'react';

// Break points inside one word: after `/`, `_` or `.` between word characters, and at a camelCase hump.
const BOUNDARY = /(?<=\w[/_.])(?=\w)|(?<=[a-z0-9])(?=[A-Z])/;
const SPACE = /^\s+$/;
const NOWRAP = {whiteSpace: 'nowrap'} as const;

// Pieces whose concatenation is the input: whitespace runs, and the unbreakable segments between break points.
function splitCode(code: string): string[] {
  return code.split(/(\s+)/).flatMap((w) => (w === '' ? [] : SPACE.test(w) ? [w] : w.split(BOUNDARY)));
}

// Inline code in a table cell (see src/remark/tableCodeBreaks.ts): the browser may break it only at spaces and the
// BOUNDARY points, never mid-segment. Spans and <wbr> add no text, so copying the code is unchanged.
// A component, not MDX `<code>` with these children: Docusaurus renders a `code` with element children as a code block.
export default function TableCodeBreaks({children}: {children: string}): React.ReactElement {
  const parts = splitCode(children);
  return (
    <code>
      {parts.map((p, i) =>
        SPACE.test(p) ? (
          p
        ) : (
          <React.Fragment key={i}>
            {i > 0 && !SPACE.test(parts[i - 1]) && <wbr />}
            <span style={NOWRAP}>{p}</span>
          </React.Fragment>
        ),
      )}
    </code>
  );
}
