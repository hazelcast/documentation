import React from 'react';
import {CheckCircle, XCircle} from 'react-feather';
import {Icon as HiveIcon} from '@hazelcast/ui/lib/components/Icon';

// Icons that are content (the feature matrix ticks/crosses), not decoration.
// Rendered as icons rather than ✓/✗ text so no text is added to the page.
// Keyed by role, which carries the meaning; add an entry for any new `icon:` role.
const ICONS = {
  success: {
    icon: CheckCircle,
    ariaLabel: 'Supported',
    color: 'var(--hive-color-success-v4)',
  },
  error: {
    // Circled XCircle reads as "no", not "warning" (HIVE's AlertCircle).
    icon: XCircle,
    ariaLabel: 'Not supported',
    color: 'var(--hive-color-error-v4)',
  },
} as const;

export type IconRole = keyof typeof ICONS;

// HIVE's <Icon> renders a <div>, which is invalid inside a <p>; mid-prose use would need a span.
export default function Icon({role}: {role: IconRole}): React.ReactElement | null {
  const def = ICONS[role];
  if (!def) return null;
  return <HiveIcon icon={def.icon} size="medium" color={def.color} ariaLabel={def.ariaLabel} />;
}
