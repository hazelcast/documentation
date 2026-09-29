// Resolve `<Variable name="…"/>` inside headings to its text at MDX compile time.
//
// Docusaurus builds TOC entries from the heading's MDX and keeps only the tag name of JSX elements, so the value would be lost.
// Same lookup as <Variable> (per-version wins, unknown name renders as the name).
// Must run before Docusaurus's TOC plugin, so register via `beforeDefaultRemarkPlugins`. Name form only.
import path from 'path';
import {variables, versionedVariables} from '../variables';

type Node = {
  type: string;
  name?: string | null;
  value?: string;
  attributes?: {type: string; name?: string; value?: unknown}[];
  children?: Node[];
};

// Version of the source file: `<id>_versioned_docs/version-X/…` is X, anything else is current.
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
