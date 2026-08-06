// Swizzled (ejected) from @docusaurus/theme-classic to render Asciidoctor
// callout numbers (conums). Opt-in per code block via a bare `conums` flag in
// the fence info string; the callout markers live INLINE as `<N>` at the end of
// their own lines (native Asciidoctor form), so they stay attached to the line
// when the code is edited. Here we strip the `<N>` markers, record which line
// each is on, and hand the map to the metadata for Content/Line to render a
// badge. Blocks without the flag are untouched. This is the only change from
// upstream.
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

// Doc-variable lookup for the active docs component + version, so a `vars` code
// block resolves its {attribute} placeholders (kept, not baked) at render — the
// in-code analogue of <Variable>. Per-version values win over global ones.
function useVariableLookup() {
  const active = useActivePluginAndVersion();
  const pluginId = active?.activePlugin?.pluginId;
  const versionName = active?.activeVersion?.name;
  const perVersion =
    (pluginId && versionName && versionedVariables[pluginId]?.[versionName]) || {};
  return {...variables, ...perVersion};
}

// Strip a trailing `<N>` conum marker from each line. Returns the cleaned code
// and a { lineIndex: value } map. The whitespace BEFORE the marker is preserved
// so the rendered code matches the source spacing.
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
  // `vars`: resolve {attribute} placeholders kept in the code (never baked).
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
