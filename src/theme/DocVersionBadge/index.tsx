import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Translate from '@docusaurus/Translate';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';
// HIVE's own compiled Badge styles, borrowed the same way the inline badge in
// src/components/Badge does: the pill tracks upstream colour/padding/radius
// tweaks without us re-declaring them.
import hive from '@hazelcast/ui/lib/components/Badge.module.scss';
import type {Props} from '@theme/DocVersionBadge';
import styles from './styles.module.css';

// Ejected so the version pill is a HIVE pill, like the page-level badges it now
// shares a row with (src/components/Badge) — stock renders an Infima
// `badge badge--secondary` span, which knows nothing about HIVE's tokens and
// clashed with the Enterprise pill beside it.
//
// Not HIVE's <Badge> component: that always renders an icon (its `icon` prop
// swaps the glyph, it cannot switch one off) and a version needs none. So this
// is a span wearing HIVE's real Badge classes, minus the icon — which also
// rules out `hive.content` for the label, whose margin-left is the icon gap.
//
// The logic is stock — same `badge` guard, same translated label, same theme
// class — so DocCategoryGeneratedIndexPage, the other call site, still works.
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
