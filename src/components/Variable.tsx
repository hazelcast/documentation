import React from 'react';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import {variables, versionedVariables} from '@site/src/variables';
import substitute from '@site/plugins/lib/substitute-attributes';

// Single-sourced doc variables, resolved per active docs component + version (per-version values win).
//   <Variable name="x"/>                  -> the value, as text
//   <Variable href="…{x}…" text="…{y}…"/> -> a link; {name} tokens resolved in both
// `code` renders the link label in monospace (Markdown can't carry an unresolved `{attr}` in a code-labelled link href).
export default function Variable(props: {
  name?: string;
  href?: string;
  text?: string;
  code?: boolean;
}): React.ReactElement {
  const active = useActivePluginAndVersion();
  const pluginId = active?.activePlugin?.pluginId;
  const versionName = active?.activeVersion?.name;
  const perVersion =
    (pluginId && versionName && versionedVariables[pluginId]?.[versionName]) || {};
  const lookup = {...variables, ...perVersion};

  if (props.href !== undefined) {
    const text = substitute(props.text ?? '', lookup);
    return (
      <a href={substitute(props.href, lookup)} target="_blank" rel="noopener">
        {props.code ? <code>{text}</code> : text}
      </a>
    );
  }
  const name = props.name ?? '';
  return <>{lookup[name] ?? name}</>;
}
