// Swizzled from @docusaurus/theme-classic. Only change: a `conum` value appends Asciidoctor callout markup;
// `.conum` CSS (src/css/custom.css) renders the badge and hides the `(N)` fallback, which stays in the DOM.
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
