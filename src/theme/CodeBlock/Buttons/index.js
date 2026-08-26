// Swizzled (ejected) from @docusaurus/theme-classic. Only change from upstream:
// the buttons are laid out in the flow of the code block's header bar (see
// CodeBlock/Layout) instead of being absolutely positioned over the first line
// of code, so they are always visible rather than fading in on hover. The
// component stays browser-only, as upstream — the header reserves its height so
// nothing shifts when the buttons mount.
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
