import {useEffect, type ReactNode} from 'react';
import {useActivePlugin, useActiveDocContext, useVersions} from '@docusaurus/plugin-content-docs/client';
import DocsVersionDropdownNavbarItem from '@theme-original/NavbarItem/DocsVersionDropdownNavbarItem';
import type DocsVersionDropdownNavbarItemType from '@theme/NavbarItem/DocsVersionDropdownNavbarItem';
import type {WrapperProps} from '@docusaurus/types';
import {pushDataLayer} from '@site/src/lib/analytics';

type Props = WrapperProps<typeof DocsVersionDropdownNavbarItemType>;

// The stock items expose no click hook, so match clicked navbar links against this instance's version labels.
// One document listener covers the mobile sidebar too: the desktop item stays mounted (CSS-hidden) on mobile.
function VersionChangeTracker({docsPluginId}: {docsPluginId: string}): null {
  const versions = useVersions(docsPluginId);
  const {activeVersion} = useActiveDocContext(docsPluginId);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('.navbar a');
      if (!link || !activeVersion) {
        return;
      }
      // Set on the dropdown's archive item in docusaurus.config.ts.
      const toArchives = link.classList.contains('archived-versions-link');
      const target = versions.find((v) => v.label === link.textContent?.trim());
      if (!toArchives && (!target || target.name === activeVersion.name)) {
        return;
      }
      pushDataLayer('version_change', {
        product: docsPluginId,
        from_version: activeVersion.label,
        to_version: toArchives ? 'archives' : target!.label,
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [docsPluginId, versions, activeVersion]);

  return null;
}

// Render a dropdown only while its own docs instance is active (stock shows every instance's selector on every page).
export default function DocsVersionDropdownNavbarItemWrapper(
  props: Props,
): ReactNode {
  const activePlugin = useActivePlugin();
  if (activePlugin?.pluginId !== props.docsPluginId) {
    return null;
  }
  return (
    <>
      {!props.mobile && <VersionChangeTracker docsPluginId={props.docsPluginId} />}
      <DocsVersionDropdownNavbarItem {...props} />
    </>
  );
}
