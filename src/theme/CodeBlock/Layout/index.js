// Swizzled from @docusaurus/theme-classic. Changes from upstream:
//   - a header bar above every block holds the language label and the always-visible action buttons
//   - a `title=` block renders its title as a caption above the block, not a bar inside it
import React from 'react';
import clsx from 'clsx';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import Container from '@theme/CodeBlock/Container';
import Title from '@theme/CodeBlock/Title';
import Content from '@theme/CodeBlock/Content';
import Buttons from '@theme/CodeBlock/Buttons';
import styles from './styles.module.css';

// Fence languages that carry no language name; nothing is labelled for them.
const UNLABELLED_LANGUAGES = new Set(['none', 'text', 'plain', 'plaintext']);

// The label is the language as given (already lowercased by Docusaurus), not a display name.
function languageLabel(language) {
  if (!language || UNLABELLED_LANGUAGES.has(language)) {
    return undefined;
  }
  return language;
}

export default function CodeBlockLayout({className}) {
  const {metadata} = useCodeBlockContext();
  const label = languageLabel(metadata.language);
  return (
    <>
      {metadata.title && (
        <div className={styles.codeBlockTitle}>
          <Title>{metadata.title}</Title>
        </div>
      )}
      <Container as="div" className={clsx(className, metadata.className)}>
        <div className={styles.codeBlockContent}>
          <div className={styles.codeBlockHeader}>
            <span className={styles.codeBlockLanguage}>{label}</span>
            <Buttons />
          </div>
          <Content />
        </div>
      </Container>
    </>
  );
}
