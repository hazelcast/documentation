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
import CodeBlockLayout from '@theme/CodeBlock/Layout';

const hasConumsFlag = (metastring) =>
  !!metastring && metastring.split(/\s+/).includes('conums');

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
  let code = props.children;
  let conums;
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
