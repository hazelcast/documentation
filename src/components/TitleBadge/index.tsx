import React from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

// Registry of page-level title badges. Each key is a custom frontmatter tag
// (e.g. `dedicated: true`); add a new badge type by adding an entry here.
type BadgeDef = {
  label: string;
  href: string;
  tooltip: string;
};

export const BADGES: Record<string, BadgeDef> = {
  dedicated: {
    label: 'Dedicated',
    href: '/dedicated-cluster',
    tooltip: 'Dedicated is a managed Hazelcast Cloud service',
  },
};

// Frontmatter keys that map to a badge, in registry (display) order.
export const BADGE_KEYS = Object.keys(BADGES);

function TitleBadge({name}: {name: string}): React.ReactElement | null {
  const badge = BADGES[name];
  if (!badge) {
    return null;
  }
  return (
    <span className={styles.badge}>
      <button
        type="button"
        className={styles.trigger}
        aria-label={`${badge.label}: more information`}>
        {badge.label}
      </button>
      <span role="note" className={styles.popover}>
        {badge.tooltip}{' '}
        <Link to={badge.href}>Learn more</Link>
      </span>
    </span>
  );
}

// A row of title badges rendered above the page title. Returns null when the
// page declares no badge frontmatter, so it takes no vertical space.
export default function TitleBadgeRow({
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
        <TitleBadge key={name} name={name} />
      ))}
    </div>
  );
}
