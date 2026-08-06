import React from 'react';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import {variables, versionedVariables} from '@site/src/variables';
import substitute from '@site/plugins/lib/substitute-attributes';

// The one component for single-sourced doc variables — values that must stay
// attributes, never baked (e.g. per-version product version numbers). Two modes:
//
//   <Variable name="page-latest-supported-hazelcast"/>   -> the value, as text
//   <Variable href="…{x}…" text="…{y}…"/>                -> a link
//
// In link mode, {name} tokens in `href` and `text` are resolved (so a version
// number can be one part of a URL or label). Everything resolves for the active
// docs component + version, per-version values winning over global ones, so
// values stay correct across versions instead of being baked into the page.
export default function Variable(props: {
  name?: string;
  href?: string;
  text?: string;
}): React.ReactElement {
  const active = useActivePluginAndVersion();
  const pluginId = active?.activePlugin?.pluginId;
  const versionName = active?.activeVersion?.name;
  const perVersion =
    (pluginId && versionName && versionedVariables[pluginId]?.[versionName]) || {};
  const lookup = {...variables, ...perVersion};

  if (props.href !== undefined) {
    return (
      <a href={substitute(props.href, lookup)} target="_blank" rel="noopener">
        {substitute(props.text ?? '', lookup)}
      </a>
    );
  }
  const name = props.name ?? '';
  return <>{lookup[name] ?? name}</>;
}
