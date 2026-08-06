// Swizzled (ejected) from @docusaurus/theme-classic. Only change from upstream:
// when a `conum` value is present for this line, append Asciidoctor's callout
// markup (`<i class="conum" data-value="N"></i><b>(N)</b>`) after the code. The
// `.conum` CSS (src/css/custom.css, ported from the Antora UI) renders it as a
// circled number badge and hides the `(N)` fallback — matching production, while
// keeping the `(N)` in the DOM so the fidelity text compare still matches.
import React from 'react';
import clsx from 'clsx';
import LineToken from '@theme/CodeBlock/Line/Token';
import styles from './styles.module.css';

function LineBreak() {
  return <br />;
}

function fixLineBreak(line) {
  const singleLineBreakToken =
    line.length === 1 && line[0].content === '\n' ? line[0] : undefined;
  if (singleLineBreakToken) {
    return [{...singleLineBreakToken, content: ''}];
  }
  return line;
}

function Conum({value}) {
  return (
    <>
      <i className="conum" data-value={value} />
      <b>({value})</b>
    </>
  );
}

export default function CodeBlockLine({
  line: lineProp,
  classNames,
  showLineNumbers,
  getLineProps,
  getTokenProps,
  conum,
}) {
  const line = fixLineBreak(lineProp);
  const lineProps = getLineProps({
    line,
    className: clsx(classNames, showLineNumbers && styles.codeLine),
  });
  const lineTokens = line.map((token, key) => {
    const tokenProps = getTokenProps({token});
    return (
      <LineToken key={key} {...tokenProps} line={line} token={token}>
        {tokenProps.children}
      </LineToken>
    );
  });
  return (
    <div {...lineProps}>
      {showLineNumbers ? (
        <>
          <span className={styles.codeLineNumber} />
          <span className={styles.codeLineContent}>
            {lineTokens}
            {conum !== undefined && <Conum value={conum} />}
          </span>
        </>
      ) : (
        <>
          {lineTokens}
          {conum !== undefined && <Conum value={conum} />}
        </>
      )}
      <LineBreak />
    </div>
  );
}
