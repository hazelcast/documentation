import {useEffect, useRef, type ReactNode} from 'react';
import type {Props} from '@theme/ColorModeToggle';
import {ThemeSwitcher} from '@hazelcast/ui/lib/components/ThemeSwitcher';

const CLOSE_DELAY_MS = 150;

// Replaces Docusaurus's toggle with the HIVE switcher. Docusaurus stores "system" as a null choice.
// The switcher only closes on an outside click, but the version dropdown closes when the pointer leaves it, so this does the same.
// React sends mouseleave through the portal, so the wrapper sees the trigger and the menu as one area. HIVE's popover closes on a document-level Escape, which leaves focus alone.
export default function ColorModeToggle({className, value, onChange}: Props): ReactNode {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <span
      className={className}
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={() => {
        timer.current = setTimeout(() => {
          if (!document.querySelector('[role="menu"][aria-label="Color theme"]')) return;
          document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        }, CLOSE_DELAY_MS);
      }}
    >
      <ThemeSwitcher
        value={value ?? 'system'}
        onChange={(preference) => onChange(preference === 'system' ? null : preference)}
      />
    </span>
  );
}
