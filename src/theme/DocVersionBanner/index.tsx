import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {
  useActivePlugin,
  useDocsPreferredVersion,
  useDocsVersion,
} from '@docusaurus/plugin-content-docs/client';
import type {Props} from '@theme/DocVersionBanner';
import useLatestCounterpart from '@site/src/lib/useLatestCounterpart';

// Ejected for three reasons:
//   - wording: stock says an older version is "no longer actively maintained",
//     which is a support-policy claim the banner should not make;
//   - naming: stock names the SITE title ("Hazelcast Documentation 5.10"), not
//     the product;
//   - the link: stock finds the same page in the latest version by doc id, which
//     misses most counterparts here (see useLatestCounterpart), so it matches on
//     URL and falls back to the latest version's main doc.

// Keyed by docs plugin id. Unversioned components never show a banner.
const PRODUCT_NAMES: Record<string, string> = {
  hazelcast: 'Hazelcast Platform',
  'management-center': 'Hazelcast Management Center',
  operator: 'Hazelcast Platform Operator',
  clc: 'Hazelcast CLC',
};

export default function DocVersionBanner({className}: Props): ReactNode {
  const versionMetadata = useDocsVersion();
  const {pluginId} = useActivePlugin({failfast: true});
  const {savePreferredVersionName} = useDocsPreferredVersion(pluginId);
  const counterpart = useLatestCounterpart();

  if (!versionMetadata.banner || !counterpart) {
    return null;
  }
  const {latest} = counterpart;
  const to =
    counterpart.path ??
    latest.docs.find((doc) => doc.id === latest.mainDocId)?.path ??
    latest.path;
  const product = PRODUCT_NAMES[pluginId] ?? pluginId;
  const unreleased = versionMetadata.banner === 'unreleased';

  return (
    <div
      className={clsx(
        className,
        ThemeClassNames.docs.docVersionBanner,
        'alert alert--warning margin-bottom--md',
      )}
      role="alert">
      <div>
        This is documentation for{' '}
        <b>
          {product} {versionMetadata.label}
        </b>
        , which {unreleased ? 'has not been released yet' : 'is not the most recent version'}.
      </div>
      <div className="margin-top--md">
        {unreleased ? 'For the current release' : 'For up-to-date documentation'}, see the{' '}
        <b>
          <Link to={to} onClick={() => savePreferredVersionName(latest.name)}>
            latest version
          </Link>
        </b>{' '}
        ({latest.label}).
      </div>
    </div>
  );
}
