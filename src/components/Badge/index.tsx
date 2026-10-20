import React, {useEffect, useRef} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';
import DocVersionBadge from '@theme/DocVersionBadge';
import {AlertTriangle} from 'react-feather';
import {
  Badge as HiveBadge,
  type BadgeIconDescriptor,
  BadgeIcon,
  type BadgeType,
} from '@hazelcast/ui/lib/components/Badge';
// HIVE's compiled Badge styles, borrowed so the inline pill tracks upstream style changes.
import hive from '@hazelcast/ui/lib/components/Badge.module.css';
import styles from './styles.module.css';

// Single source of truth for every badge type. Inline `<Badge type/>` is a <span> wearing HIVE's Badge classes
// (HIVE's <Badge> is a <div>, invalid inside <p>); page-level frontmatter badges render the real HIVE <Badge>.
// `hiveType` selects HIVE's colour and icon.
type BadgeDef = {
  label: string;
  tooltip: string;
  href?: string;
  hiveType: BadgeType;
  // Overrides the icon HIVE derives from `hiveType`, so colour and glyph are chosen independently.
  icon?: BadgeIconDescriptor;
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
    // Matches the `enterprise-product-name` attribute. The label is a literal, so it must change with
    // that attribute (refcheck records this as `bake:badge-label`).
    label: 'Enterprise Edition',
    // Link deferred until the Enterprise explainer page has a stable URL.
    tooltip:
      'This feature requires Hazelcast Enterprise, a licensed edition of the Hazelcast Platform.',
    hiveType: 'neutral',
  },
  beta: {
    label: 'Beta',
    tooltip:
      'This feature is in beta and is not recommended for production use. It is separately licensed. If you are interested in trialing this feature, contact your Hazelcast representative.',
    hiveType: 'neutral',
    icon: {icon: AlertTriangle, ariaLabel: 'Warning'},
  },
  experimental: {
    label: 'Experimental',
    tooltip:
      'This is an experimental feature and is not recommended for production use. It is separately licensed. If you are interested in trialing this feature, contact your Hazelcast representative.',
    hiveType: 'neutral',
    icon: {icon: AlertTriangle, ariaLabel: 'Warning'},
  },
};

// Frontmatter keys that map to a page-level badge, in registry (display) order.
export const BADGE_KEYS = Object.keys(BADGES);

// Gap kept between an open popover and the viewport's right edge.
const EDGE = 16;

// Shared hover/focus popover: explanatory text + optional "Learn more" link.
// It opens from the badge's left edge; near the right of a narrow screen it is shifted left to stay on screen.
function Popover({def}: {def: BadgeDef}): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const popover = ref.current;
    const badge = popover?.parentElement;
    if (!popover || !badge) return;
    // Placed before it is shown: a tap fires `pointerenter` at touch-down, but applies `:hover` only after it.
    // Shown inline just long enough to measure; nothing paints in between.
    const place = () => {
      popover.style.left = '';
      popover.style.display = 'block';
      const overflow = popover.getBoundingClientRect().right - (document.documentElement.clientWidth - EDGE);
      popover.style.display = '';
      if (overflow > 0) popover.style.left = `${-overflow}px`;
    };
    badge.addEventListener('pointerenter', place);
    badge.addEventListener('focusin', place);
    return () => {
      badge.removeEventListener('pointerenter', place);
      badge.removeEventListener('focusin', place);
    };
  }, []);
  return (
    <span ref={ref} role="note" className={styles.popover}>
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
  const {icon: IconCmp} = def.icon ?? BadgeIcon[def.hiveType];
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

// Page-level badge row above the title, using the real HIVE <Badge> in a <div>. Leads with the version pill,
// so it renders only from DocItem/Content, where the docs-version context exists. Null when there is nothing to show.
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
            <HiveBadge
              type={def.hiveType}
              content={def.label}
              icon={def.icon}
            />
            <Popover def={def} />
          </div>
        );
      })}
    </div>
  );
}
