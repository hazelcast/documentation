import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Translate from '@docusaurus/Translate';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';
// HIVE's compiled Badge styles, borrowed as in src/components/Badge.
import hive from '@hazelcast/ui/lib/components/Badge.module.css';
import type {Props} from '@theme/DocVersionBadge';
import styles from './styles.module.css';

// Ejected so the version pill is a HIVE pill matching the page-level badges (stock renders an Infima badge).
// A span with HIVE's Badge classes, not <Badge>: that always renders an icon, and `hive.content` has an icon-gap margin.
// Logic is stock, so DocCategoryGeneratedIndexPage still works.
export default function DocVersionBadge({className}: Props): ReactNode {
  const versionMetadata = useDocsVersion();
  if (!versionMetadata.badge) {
    return null;
  }
  return (
    <span
      className={clsx(
        className,
        ThemeClassNames.docs.docVersionBadge,
        hive.badge,
        hive.neutral,
      )}>
      <span className={styles.label}>
        <Translate
          id="theme.docs.versionBadge.label"
          values={{versionLabel: versionMetadata.label}}>
          {'Version: {versionLabel}'}
        </Translate>
      </span>
    </span>
  );
}
