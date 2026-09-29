import type {ReactNode} from 'react';
import {useActivePlugin} from '@docusaurus/plugin-content-docs/client';
import DocsVersionDropdownNavbarItem from '@theme-original/NavbarItem/DocsVersionDropdownNavbarItem';
import type DocsVersionDropdownNavbarItemType from '@theme/NavbarItem/DocsVersionDropdownNavbarItem';
import type {WrapperProps} from '@docusaurus/types';

type Props = WrapperProps<typeof DocsVersionDropdownNavbarItemType>;

// Render a dropdown only while its own docs instance is active (stock shows every instance's selector on every page).
export default function DocsVersionDropdownNavbarItemWrapper(
  props: Props,
): ReactNode {
  const activePlugin = useActivePlugin();
  if (activePlugin?.pluginId !== props.docsPluginId) {
    return null;
  }
  return <DocsVersionDropdownNavbarItem {...props} />;
}
