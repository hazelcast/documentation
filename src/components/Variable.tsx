import React from 'react';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import {variables, versionedVariables} from '@site/src/variables';
import substitute from '@site/plugins/lib/substitute-attributes';

// The one component for single-sourced doc variables — values that must stay
// attributes, never baked (e.g. per-version product version numbers). Two modes:
//
//   <Variable name="page-latest-supported-hazelcast"/>   -> the value, as text
//   <Variable href="…{x}…" text="…{y}…"/>                -> a link
//   <Variable href="…" text="…" code/>                   -> a link labelled in code
//
// In link mode, {name} tokens in `href` and `text` are resolved (so a version
// number can be one part of a URL or label). Everything resolves for the active
// docs component + version, per-version values winning over global ones, so
// values stay correct across versions instead of being baked into the page.
//
// `code` exists because Asciidoctor's monospaced cross-reference renders as
// `<code><a href>label</a></code>` (hazelcast's Maven-artifact table columns), and
// Markdown's own form for that — a link with a code label — has nowhere to put an
// unresolved `{attr}` in its href. So the link stays a <Variable> and this renders
// the label as monospace.
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
