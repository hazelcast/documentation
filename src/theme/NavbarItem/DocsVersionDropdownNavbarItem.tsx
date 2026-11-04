import {useEffect, type ReactNode} from 'react';
import {
  useActivePlugin,
  useActiveDocContext,
  useDocsPreferredVersion,
  useDocsVersionCandidates,
  useVersions,
  type GlobalVersion,
} from '@docusaurus/plugin-content-docs/client';
import {useLocation} from '@docusaurus/router';
import {translate} from '@docusaurus/Translate';
import DropdownNavbarItem from '@theme/NavbarItem/DropdownNavbarItem';
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

// The version menu opens on click, not hover, as the theme menu does. The stock dropdown toggles its menu only on an Enter or Space keydown on its label (a click
// navigates, and hover opens it through CSS, which custom.css switches off), so a click on the label is turned into that keydown and the stock state keeps ownership.
// Escape and picking a version close the menu the same way; an outside click is already handled by the stock component.
const DROPDOWN = '.navbar__items--right > .dropdown';

function toggleDropdown(dropdown: Element | null): void {
  dropdown
    ?.querySelector(':scope > a')
    ?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
}

function VersionDropdownClickToOpen(): null {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const label = target?.closest?.(`${DROPDOWN} > a`);
      if (label) {
        // Without this the label would also navigate to the current version's page.
        event.preventDefault();
        event.stopPropagation();
        toggleDropdown(label.parentElement);
        return;
      }
      const item = target?.closest?.(`${DROPDOWN}.dropdown--show .dropdown__menu a`);
      if (item) {
        toggleDropdown(item.closest(DROPDOWN));
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        toggleDropdown(document.querySelector(`${DROPDOWN}.dropdown--show`));
      }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return null;
}

// Replaces the stock dropdown, which links to the same doc ID in each version and otherwise to the version's landing page. A page that moved
// folders between versions keeps its URL through its `slug` but gets a new ID, so a page with the same URL is tried before the stock fallback.
// Drops the stock `versions` option and single-version button, which no product here uses.
function VersionDropdown({mobile, docsPluginId, dropdownItemsBefore = [], dropdownItemsAfter = [], ...props}: Props): ReactNode {
  const versions = useVersions(docsPluginId);
  const {activeVersion, alternateDocVersions} = useActiveDocContext(docsPluginId);
  const candidates = useDocsVersionCandidates(docsPluginId);
  const {savePreferredVersionName} = useDocsPreferredVersion(docsPluginId);
  const {pathname, search, hash} = useLocation();
  const rest = activeVersion && pathname.startsWith(`${activeVersion.path}/`) ? pathname.slice(activeVersion.path.length) : undefined;

  const targetPath = (version: GlobalVersion): string =>
    (rest !== undefined && version.docs.find((d) => d.path === `${version.path}${rest}`)?.path) ||
    (alternateDocVersions[version.name] ?? version.docs.find((d) => d.id === version.mainDocId)!).path;

  const displayed = candidates.find((c) => versions.includes(c)) ?? versions[0];
  return (
    <DropdownNavbarItem
      {...props}
      mobile={mobile}
      label={mobile ? translate({id: 'theme.navbar.mobileVersionsDropdown.label', message: 'Versions'}) : displayed.label}
      to={mobile ? undefined : targetPath(displayed)}
      items={[
        ...dropdownItemsBefore,
        ...versions.map((version) => ({
          label: version.label,
          to: `${targetPath(version)}${search}${hash}`,
          isActive: () => version === activeVersion,
          onClick: () => savePreferredVersionName(version.name),
        })),
        ...dropdownItemsAfter,
      ]}
    />
  );
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
      {!props.mobile && <VersionDropdownClickToOpen />}
      <VersionDropdown {...props} />
    </>
  );
}
