import type {ReactNode} from 'react';
import clsx from 'clsx';
import useIsBrowser from '@docusaurus/useIsBrowser';
import type {Props} from '@theme/ColorModeToggle';
import {Icon} from '@hazelcast/ui/lib/components/Icon';
import {ThemeSwitcher} from '@hazelcast/ui/lib/components/ThemeSwitcher';
import hiveStyles from '@hazelcast/ui/lib/components/ThemeSwitcher.module.css';
import {HalfCircle} from '@hazelcast/ui/lib/icons/HalfCircle';
import {Moon, Sun} from 'react-feather';
import styles from './styles.module.css';

// shortcut: until HIVE's ThemeSwitcher picks its icon from data-theme-choice, the server render
// can't know the saved choice, so a static trigger shows all three icons and CSS picks one. Remove once HIVE ships the fix.
function Placeholder({className}: {className?: string}): ReactNode {
  return (
    <button type="button" className={clsx(hiveStyles.trigger, className)} aria-label="Color theme" data-test="theme-switcher">
      <Icon icon={Sun} size="smallMedium" ariaHidden containerClassName={clsx(styles.icon, styles.light)} />
      <Icon icon={Moon} size="smallMedium" ariaHidden containerClassName={clsx(styles.icon, styles.dark)} />
      <Icon icon={HalfCircle} size="smallMedium" ariaHidden containerClassName={clsx(styles.icon, styles.system)} />
    </button>
  );
}

// Replaces Docusaurus's toggle with the HIVE switcher. Docusaurus stores "system" as a null choice.
export default function ColorModeToggle({className, value, onChange}: Props): ReactNode {
  if (!useIsBrowser()) return <Placeholder className={className} />;
  return (
    <ThemeSwitcher
      className={className}
      value={value ?? 'system'}
      onChange={(preference) => onChange(preference === 'system' ? null : preference)}
    />
  );
}
