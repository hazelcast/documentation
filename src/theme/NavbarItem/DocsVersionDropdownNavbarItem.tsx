import type {ReactNode} from 'react';
import {useActivePlugin} from '@docusaurus/plugin-content-docs/client';
import DocsVersionDropdownNavbarItem from '@theme-original/NavbarItem/DocsVersionDropdownNavbarItem';
import type DocsVersionDropdownNavbarItemType from '@theme/NavbarItem/DocsVersionDropdownNavbarItem';
import type {WrapperProps} from '@docusaurus/types';

type Props = WrapperProps<typeof DocsVersionDropdownNavbarItemType>;

// The stock version dropdown renders on every page, so each versioned docs
// instance would show its selector while you are reading another one. Render
// a dropdown only while its own docs instance is the active one.
export default function DocsVersionDropdownNavbarItemWrapper(
  props: Props,
): ReactNode {
  const activePlugin = useActivePlugin();
  if (activePlugin?.pluginId !== props.docsPluginId) {
    return null;
  }
  return <DocsVersionDropdownNavbarItem {...props} />;
}
