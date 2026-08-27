import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';
import DocVersionBadge from '@theme/DocVersionBadge';
import {
  Badge as HiveBadge,
  BadgeIcon,
  type BadgeType,
} from '@hazelcast/ui/lib/components/Badge';
// HIVE's own compiled Badge styles — borrowed for the inline mode so the pill
// tracks upstream style tweaks (colours/padding/radius) short of a structural
// redesign. Same file the real <Badge> uses, so both modes stay in sync.
import hive from '@hazelcast/ui/lib/components/Badge.module.scss';
import styles from './styles.module.css';

// Single source of truth for every badge type. Two sources, two render modes:
//   - inline `<Badge type="…"/>` (source #1): appears mid-prose, so it must be
//     inline-valid HTML. HIVE's <Badge> is a block <div> (illegal inside <p>),
//     so inline badges are our own <span> wearing HIVE's real Badge classes
//     (hive.badge + type) and its per-type icon (BadgeIcon).
//   - page-level (frontmatter tag, source #2): a row above the title, block
//     context — renders the REAL HIVE <Badge>, which fully tracks HIVE.
// Both take their text from `label` and their tooltip from the shared popover.
// `hiveType` selects HIVE's semantic colour + icon; change it here to recolour.
type BadgeDef = {
  label: string;
  tooltip: string;
  href?: string;
  hiveType: BadgeType;
};

export const BADGES: Record<string, BadgeDef> = {
  dedicated: {
    label: 'Cloud Dedicated',
    tooltip:
      'This feature requires Cloud Dedicated, a managed Hazelcast Cloud service.',
    href: '/cloud/dedicated-cluster',
    hiveType: 'neutral',
  },
  serverless: {
    label: 'Cloud Standard',
    tooltip:
      'This feature requires Cloud Standard, a managed Hazelcast Cloud service.',
    href: '/cloud/serverless-cluster',
    hiveType: 'neutral',
  },
  enterprise: {
    // "Enterprise Edition", not "Enterprise": this is the value of both Platform's
    // and Management Center's `enterprise-product-name` Antora attribute, and what
    // Platform's 37 badge occurrences render today (`[.enterprise]*{enterprise-product-name}*`).
    // MC's single occurrence writes the literal `Enterprise` instead — a source
    // inconsistency, not a different value — so that one sentence ("a feature ... is
    // labelled <Badge/>") now reads "Enterprise Edition", which is what the badge
    // beside it actually says. User decision 2026-08-27.
    //
    // The label is a literal here rather than a doc variable, so it does not follow
    // `enterprise-product-name` automatically; refcheck records that trade as
    // `bake:badge-label` (see refcheck/lib/bake-contexts.js). If the attribute ever
    // changes, this string has to change with it.
    label: 'Enterprise Edition',
    // Link deferred until platform (hz-docs) migrates and the Enterprise
    // explainer page has a stable URL.
    tooltip:
      'This feature requires Hazelcast Enterprise, a licensed edition of the Hazelcast Platform.',
    hiveType: 'neutral',
  },
};

// Frontmatter keys that map to a page-level badge, in registry (display) order.
export const BADGE_KEYS = Object.keys(BADGES);

// Shared hover/focus popover: explanatory text + optional "Learn more" link.
function Popover({def}: {def: BadgeDef}): React.ReactElement {
  return (
    <span role="note" className={styles.popover}>
      {def.tooltip}
      {def.href ? (
        <>
          {' '}
          <Link to={def.href}>Learn more</Link>
        </>
      ) : null}
    </span>
  );
}

// Inline badge (source #1). Registered globally in MDXComponents, so pages use
// it without an import. An unknown type renders nothing.
export default function Badge({
  type,
}: {
  type: string;
}): React.ReactElement | null {
  const def = BADGES[type];
  if (!def) {
    return null;
  }
  const {icon: IconCmp} = BadgeIcon[def.hiveType];
  return (
    <span className={styles.badge}>
      <span
        className={clsx(hive.badge, hive[def.hiveType], styles.trigger)}
        tabIndex={0}
        aria-label={`${def.label}: more information`}>
        <IconCmp size={16} aria-hidden className={styles.icon} />
        <span className={hive.content}>{def.label}</span>
      </span>
      <Popover def={def} />
    </span>
  );
}

// Page-level badge row, above the title (source #2). Uses the REAL HIVE <Badge>
// inside a <div> wrapper (HIVE's Badge is a <div>, illegal inside a <span>).
// Docusaurus' own version pill leads the row: it is the same kind of thing and
// the same HIVE pill (see src/theme/DocVersionBadge), so it belongs on the same
// line rather than stacked above. That is why this only renders from
// DocItem/Content, where the docs-version context exists — DocItem/Layout no
// longer renders <DocVersionBadge/> itself. Returns null when the page has
// neither a version badge nor badge frontmatter.
export function TitleBadgeRow({
  names,
}: {
  names: string[];
}): React.ReactElement | null {
  const {badge: hasVersionBadge} = useDocsVersion();
  const known = names.filter((name) => BADGES[name]);
  if (!hasVersionBadge && known.length === 0) {
    return null;
  }
  return (
    <div className={styles.row}>
      {hasVersionBadge && <DocVersionBadge />}
      {known.map((name) => {
        const def = BADGES[name];
        return (
          <div
            key={name}
            className={clsx(styles.badge, styles.trigger)}
            tabIndex={0}
            aria-label={`${def.label}: more information`}>
            <HiveBadge type={def.hiveType} content={def.label} />
            <Popover def={def} />
          </div>
        );
      })}
    </div>
  );
}
