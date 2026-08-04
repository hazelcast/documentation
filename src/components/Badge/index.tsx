import React from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

// Single source of truth for every badge type. Used in two render modes:
//   - page-level: a row of pills above the title, keyed off frontmatter tags
//     (e.g. `dedicated: true`), using `label` as the pill text.
//   - inline: `<Badge type="…">authored text</Badge>`, emitted by the converter
//     from `[.enterprise]*…*` roles, using the authored text as the label.
// Add a badge type by adding an entry here. `href` is optional: without it the
// tooltip shows text only, no "Learn more" link.
type BadgeDef = {
  label: string;
  tooltip: string;
  href?: string;
};

export const BADGES: Record<string, BadgeDef> = {
  dedicated: {
    label: 'Cloud Dedicated',
    tooltip: 'This feature requires Cloud Dedicated, a managed Hazelcast Cloud service.',
    href: '/cloud/dedicated-cluster',
  },
  serverless: {
    label: 'Cloud Standard',
    tooltip: 'This feature requires Cloud Standard, a managed Hazelcast Cloud service.',
    href: '/cloud/serverless-cluster',
  },
  enterprise: {
    label: 'Enterprise',
    // Link deferred until platform (hz-docs) migrates and the Enterprise
    // explainer page has a stable URL.
    tooltip: 'This feature requires Hazelcast Enterprise, a licensed edition of the Hazelcast Platform.',
  },
};

// Frontmatter keys that map to a page-level badge, in registry (display) order.
export const BADGE_KEYS = Object.keys(BADGES);

// A focusable trigger plus its hover/focus popover (explanatory text + optional
// "Learn more" link). Shared by the page-level and inline render modes.
function BadgeShell({
  def,
  as,
  className,
  children,
}: {
  def: BadgeDef;
  as: 'button' | 'span';
  className: string;
  children: React.ReactNode;
}): React.ReactElement {
  const Trigger = as;
  const triggerProps =
    as === 'button' ? {type: 'button' as const} : {tabIndex: 0};
  return (
    <span className={styles.badge}>
      <Trigger
        {...triggerProps}
        className={className}
        aria-label={`${def.label}: more information`}>
        {children}
      </Trigger>
      <span role="note" className={styles.popover}>
        {def.tooltip}
        {def.href ? (
          <>
            {' '}
            <Link to={def.href}>Learn more</Link>
          </>
        ) : null}
      </span>
    </span>
  );
}

// Inline badge: `<Badge type="serverless"/>`. The label comes from the registry
// (single-sourced), not the page. Registered globally in MDXComponents, so pages
// use it without an import. An unknown type renders nothing (the converter only
// emits known types).
export default function Badge({type}: {type: string}): React.ReactElement | null {
  const def = BADGES[type];
  if (!def) {
    return null;
  }
  return (
    <BadgeShell def={def} as="span" className={styles.pill}>
      {def.label}
    </BadgeShell>
  );
}

// Page-level badge row, rendered above the title. Returns null when the page
// declares no badge frontmatter, so it takes no vertical space.
export function TitleBadgeRow({
  names,
}: {
  names: string[];
}): React.ReactElement | null {
  const known = names.filter((name) => BADGES[name]);
  if (known.length === 0) {
    return null;
  }
  return (
    <div className={styles.row}>
      {known.map((name) => (
        <BadgeShell key={name} def={BADGES[name]} as="button" className={styles.pill}>
          {BADGES[name].label}
        </BadgeShell>
      ))}
    </div>
  );
}
