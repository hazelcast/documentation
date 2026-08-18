import React from 'react';
import {CheckCircle, XCircle} from 'react-feather';
import {Icon as HiveIcon} from '@hazelcast/ui/lib/components/Icon';

// AsciiDoc `icon:NAME[role=ROLE]` where the icon IS the content, not decoration.
//
// Most font icons in an Antora render are chrome — the admonition glyph, the
// external-link marker, a checklist box — and the converter drops those, because
// Docusaurus draws its own. management-center's feature matrix is the exception:
// its cells hold `icon:check-circle[size=lg,role=success]` and
// `icon:times[size=lg,role=error]`, and those ticks and crosses ARE the table's
// data (which edition has which feature). Dropping them left every row of "Key
// features and benefits" reading "feature | | | description".
//
// Rendered as an ICON rather than a `✓`/`✗` character for two reasons that agree:
// HIVE already draws these marks (its own success Badge uses this very
// react-feather CheckCircle), and the golden's `<i>` element carries NO text, so
// a text character here would add content Antora never rendered and fail the
// Layer-1 text diff. An icon adds none.
//
// Keyed by ROLE, not by icon name: the role carries the meaning (`success` = the
// edition has the feature, `error` = it does not) and decides both glyph and
// colour, while the FontAwesome-era names (`times`) do not survive the move off
// FontAwesome. A new `icon:` macro reaching a page needs an entry here — the same
// registry shape as BADGES in src/components/Badge.
const ICONS = {
  success: {
    icon: CheckCircle,
    ariaLabel: 'Supported',
    color: 'var(--hive-color-success-v4)',
  },
  error: {
    // XCircle, not HIVE's AlertCircle: this is "no", not "warning", and the
    // circled pair reads at a glance where a bare ✓/✗ pair does not.
    icon: XCircle,
    ariaLabel: 'Not supported',
    color: 'var(--hive-color-error-v4)',
  },
} as const;

export type IconRole = keyof typeof ICONS;

// NOTE: HIVE's <Icon> wraps the glyph in a `<div class="iconContainer">` (styled
// `display: inline-block`). That is valid where every current use sits — table
// cells — but a `<div>` inside a `<p>` is not, so an `icon:` macro appearing
// mid-prose would need the `<span>`-wearing-HIVE-classes treatment src/components/
// Badge uses for its inline mode.
export default function Icon({role}: {role: IconRole}): React.ReactElement | null {
  const def = ICONS[role];
  if (!def) return null;
  return <HiveIcon icon={def.icon} size="medium" color={def.color} ariaLabel={def.ariaLabel} />;
}
