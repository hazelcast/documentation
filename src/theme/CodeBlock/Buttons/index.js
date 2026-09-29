// Swizzled from @docusaurus/theme-classic. Only change: buttons sit in the code block's header bar
// (see CodeBlock/Layout), always visible, instead of absolutely positioned over the code.
import React from 'react';
import clsx from 'clsx';
import BrowserOnly from '@docusaurus/BrowserOnly';
import CopyButton from '@theme/CodeBlock/Buttons/CopyButton';
import WordWrapButton from '@theme/CodeBlock/Buttons/WordWrapButton';
import styles from './styles.module.css';

export default function CodeBlockButtons({className}) {
  return (
    <BrowserOnly>
      {() => (
        <div className={clsx(className, styles.buttonGroup)}>
          <WordWrapButton />
          <CopyButton />
        </div>
      )}
    </BrowserOnly>
  );
}
