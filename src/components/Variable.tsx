import React from 'react';
import Link from '@docusaurus/Link';
import {useActivePluginAndVersion, useAllDocsData} from '@docusaurus/plugin-content-docs/client';
import {variables, versionedVariables} from '@site/src/variables';
import substitute from '@site/plugins/lib/substitute-attributes';
import inUnbuiltVersion from '@site/src/lib/inUnbuiltVersion';

// Single-sourced doc variables, resolved per active docs component + version (per-version values win).
//   <Variable name="x"/>                  -> the value, as text
//   <Variable href="…{x}…" text="…{y}…"/> -> a link; {name} tokens resolved in both. Off-site links open in a new tab.
// `code` renders the link label in monospace (Markdown can't carry an unresolved `{attr}` in a code-labelled link href).
export default function Variable(props: {
  name?: string;
  href?: string;
  text?: string;
  code?: boolean;
}): React.ReactElement {
  const active = useActivePluginAndVersion();
  const allDocsData = useAllDocsData();
  const pluginId = active?.activePlugin?.pluginId;
  const versionName = active?.activeVersion?.name;
  const perVersion =
    (pluginId && versionName && versionedVariables[pluginId]?.[versionName]) || {};
  const lookup = {...variables, ...perVersion};

  if (props.href !== undefined) {
    const href = substitute(props.href, lookup);
    const text = substitute(props.text ?? '', lookup);
    const label = props.code ? <code>{text}</code> : text;
    if (href.startsWith('/')) {
      // Only a version this site builds can pass the broken-link check; older versions are served outside the build.
      if (inUnbuiltVersion(href, allDocsData)) {
        return <a href={href}>{label}</a>;
      }
      return <Link to={href}>{label}</Link>;
    }
    return (
      <a href={href} target="_blank" rel="noopener">
        {label}
      </a>
    );
  }
  const name = props.name ?? '';
  return <>{lookup[name] ?? name}</>;
}
