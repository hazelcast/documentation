// Renders inline code inside table cells (Markdown tables and HTML `<td>`/`<th>`) as `<TableCodeBreaks>`,
// which lets long names wrap only at readable points (see src/components/TableCodeBreaks.tsx).

type Node = {type: string; name?: string; value?: string; attributes?: unknown[]; children?: Node[]};

const isCell = (node: Node) =>
  node.type === 'tableCell' ||
  ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && (node.name === 'td' || node.name === 'th'));

export default function tableCodeBreaks() {
  return (tree: Node) => {
    const walk = (node: Node, inCell: boolean): void => {
      if (!node.children) return;
      const cell = inCell || isCell(node);
      node.children = node.children.map((child) =>
        cell && child.type === 'inlineCode'
          ? {type: 'mdxJsxTextElement', name: 'TableCodeBreaks', attributes: [], children: [{type: 'text', value: child.value}]}
          : child,
      );
      for (const child of node.children) walk(child, cell);
    };
    walk(tree, false);
  };
}
