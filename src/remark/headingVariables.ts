// Resolve `<Variable name="…"/>` inside headings to its text, at MDX compile time.
//
// WHY. Docusaurus builds each table-of-contents entry as an HTML string from the
// heading's MDX (mdx-loader remark/toc/utils.js, mdxJsxTextElementToHtml), and
// for a JSX element it keeps only the tag name and className. So
// `## <Variable name="enterprise-product-name"/> versus …` reaches the TOC as
// `<Variable></Variable> versus …` and renders as just "versus". Swizzling the
// TOC cannot help: the name is already gone by then.
//
// Resolved here, not baked by the converter: the MDX keeps its <Variable>, and
// the value comes from src/variables.ts on every build, with the same lookup
// <Variable> itself uses (per-version values win over global ones, an unknown
// name renders as the name). Must run BEFORE Docusaurus's own TOC plugin, so it
// is registered through `beforeDefaultRemarkPlugins`.
//
// Only the name form. Link-mode <Variable href text/> is left alone; no heading
// uses it.
import path from 'path';
import {variables, versionedVariables} from '../variables';

type Node = {
  type: string;
  name?: string | null;
  value?: string;
  attributes?: {type: string; name?: string; value?: unknown}[];
  children?: Node[];
};

// The docs instance's version for a source file: `<id>_versioned_docs/version-X/…`
// is release X, anything else is the current version.
function versionOf(pluginId: string, filePath: string): string {
  const rel = path.relative(path.resolve(__dirname, '../..'), filePath).split(path.sep);
  return rel[0] === `${pluginId}_versioned_docs` && rel[1]?.startsWith('version-')
    ? rel[1].slice('version-'.length)
    : 'current';
}

function variableName(node: Node): string | null {
  if (node.type !== 'mdxJsxTextElement' || node.name !== 'Variable') return null;
  const attrs = node.attributes ?? [];
  if (attrs.some((a) => a.name === 'href')) return null;
  const name = attrs.find((a) => a.type === 'mdxJsxAttribute' && a.name === 'name')?.value;
  return typeof name === 'string' ? name : null;
}

export default function headingVariables({pluginId}: {pluginId: string}) {
  return (tree: Node, file: {path?: string}) => {
    const perVersion = file.path
      ? versionedVariables[pluginId]?.[versionOf(pluginId, file.path)] ?? {}
      : {};
    const lookup: Record<string, string> = {...variables, ...perVersion};

    const resolve = (node: Node): void => {
      node.children = node.children?.map((child) => {
        const name = variableName(child);
        if (name !== null) return {type: 'text', value: lookup[name] ?? name};
        resolve(child);
        return child;
      });
    };
    const walk = (node: Node): void => {
      if (node.type === 'heading') resolve(node);
      else node.children?.forEach(walk);
    };
    walk(tree);
  };
}
