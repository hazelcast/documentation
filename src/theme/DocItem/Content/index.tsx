import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import Heading from '@theme/Heading';
import MDXContent from '@theme/MDXContent';
import {TitleBadgeRow, BADGE_KEYS} from '@site/src/components/Badge';

// Overrides the stock theme component so that page-level badges declared in
// frontmatter (e.g. `dedicated: true`) render above the title, alongside the
// version badge (TitleBadgeRow renders that one; see src/components/Badge)
function useSyntheticTitle(): string | null {
  const {metadata, frontMatter, contentTitle} = useDoc();
  const shouldRender =
    !frontMatter.hide_title && typeof contentTitle === 'undefined';
  if (!shouldRender) {
    return null;
  }
  return metadata.title;
}

export default function DocItemContent({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const syntheticTitle = useSyntheticTitle();
  const {frontMatter} = useDoc();
  const fm = frontMatter as Record<string, unknown>;
  const badges = BADGE_KEYS.filter((key) => fm[key] === true);
  return (
    <>
      <TitleBadgeRow names={badges} />
      <div className={clsx(ThemeClassNames.docs.docMarkdown, 'markdown')}>
        {syntheticTitle && (
          <header>
            <Heading as="h1">{syntheticTitle}</Heading>
          </header>
        )}
        <MDXContent>{children}</MDXContent>
      </div>
    </>
  );
}
