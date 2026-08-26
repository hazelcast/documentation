// Swizzled (ejected) from @docusaurus/theme-classic. Two changes from upstream:
//
//   - every code block gets a header bar above the code, holding the language
//     label and the action buttons, which are therefore always visible instead
//     of appearing on hover in the top-right corner of the code itself
//     (upstream's overlay hid the first line's text and gave no clue the copy
//     button existed). The bar shares the code's own background, so the block
//     still reads as one surface.
//   - a `title=` block renders its title as a CAPTION ABOVE the block rather
//     than as a bar inside it, which is where Asciidoctor puts a block title
//     too (.listingblock > .title in the Antora UI).
import React from 'react';
import clsx from 'clsx';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import Container from '@theme/CodeBlock/Container';
import Title from '@theme/CodeBlock/Title';
import Content from '@theme/CodeBlock/Content';
import Buttons from '@theme/CodeBlock/Buttons';
import styles from './styles.module.css';

// Fence languages that mean "this isn't a language" — label nothing for them
// rather than captioning a block of output or plain text with a made-up name.
const UNLABELLED_LANGUAGES = new Set(['none', 'text', 'plain', 'plaintext']);

// The label is the language exactly as the fence (or the `language` prop) gave
// it — `bash`, `js` — not a prettified display name. Docusaurus has already
// lowercased it by the time it reaches the metadata.
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
