import type {ReactNode} from 'react';
import type {Props} from '@theme/ColorModeToggle';
import {ThemeSwitcher} from '@hazelcast/ui/lib/components/ThemeSwitcher';

// Replaces Docusaurus's toggle with the HIVE switcher. Docusaurus stores "system" as a null choice.
export default function ColorModeToggle({className, value, onChange}: Props): ReactNode {
  return (
    <ThemeSwitcher
      className={className}
      value={value ?? 'system'}
      onChange={(preference) => onChange(preference === 'system' ? null : preference)}
    />
  );
}
