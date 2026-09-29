// Swizzled from @docusaurus/theme-classic to render Asciidoctor callout numbers (conums). Only change from upstream.
// Opt-in via a bare `conums` fence flag; inline `<N>` markers are stripped and mapped by line for Content/Line to badge.
import React from 'react';
import {useThemeConfig} from '@docusaurus/theme-common';
import {
  CodeBlockContextProvider,
  createCodeBlockMetadata,
  useCodeWordWrap,
} from '@docusaurus/theme-common/internal';
import {useActivePluginAndVersion} from '@docusaurus/plugin-content-docs/client';
import CodeBlockLayout from '@theme/CodeBlock/Layout';
import {variables, versionedVariables} from '@site/src/variables';
import substitute from '@site/plugins/lib/substitute-attributes';

const hasFlag = (metastring, flag) =>
  !!metastring && metastring.split(/\s+/).includes(flag);

const hasConumsFlag = (metastring) => hasFlag(metastring, 'conums');

// Doc-variable lookup for the active component + version so `vars` blocks resolve {attribute} placeholders at render. Per-version values win.
function useVariableLookup() {
  const active = useActivePluginAndVersion();
  const pluginId = active?.activePlugin?.pluginId;
  const versionName = active?.activeVersion?.name;
  const perVersion =
    (pluginId && versionName && versionedVariables[pluginId]?.[versionName]) || {};
  return {...variables, ...perVersion};
}

// Strips a trailing `<N>` conum marker per line; returns cleaned code and a { lineIndex: value } map. Whitespace before the marker is kept.
function stripConums(code) {
  const conums = {};
  const lines = String(code).split('\n').map((line, i) => {
    const m = line.match(/<(\d+)>[ \t]*$/);
    if (!m) return line;
    conums[i] = m[1];
    return line.slice(0, m.index);
  });
  return {code: lines.join('\n'), conums};
}

function useCodeBlockMetadata(props) {
  const {prism} = useThemeConfig();
  const variableLookup = useVariableLookup();
  let code = props.children;
  let conums;
  // `vars`: resolve {attribute} placeholders at render.
  if (hasFlag(props.metastring, 'vars')) {
    code = substitute(code, variableLookup);
  }
  if (hasConumsFlag(props.metastring)) {
    const stripped = stripConums(code);
    code = stripped.code;
    conums = stripped.conums;
  }
  const metadata = createCodeBlockMetadata({
    code,
    className: props.className,
    metastring: props.metastring,
    magicComments: prism.magicComments,
    defaultLanguage: prism.defaultLanguage,
    language: props.language,
    title: props.title,
    showLineNumbers: props.showLineNumbers,
  });
  return {...metadata, conums};
}

export default function CodeBlockString(props) {
  const metadata = useCodeBlockMetadata(props);
  const wordWrap = useCodeWordWrap();
  return (
    <CodeBlockContextProvider metadata={metadata} wordWrap={wordWrap}>
      <CodeBlockLayout />
    </CodeBlockContextProvider>
  );
}
