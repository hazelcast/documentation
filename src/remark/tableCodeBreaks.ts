// Renders inline code inside table cells (Markdown tables and HTML `<td>`/`<th>`) as `<TableCodeBreaks>`,
// which lets long names wrap only at readable points (see src/components/TableCodeBreaks.tsx).
// A `<Variable … code />` link in a cell gets a `breaks` attribute, which makes it render its label the same way.

type Attribute = {type: string; name?: string};
type Node = {type: string; name?: string; value?: string; attributes?: Attribute[]; children?: Node[]};

const isJsx = (node: Node) => node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement';
const isCell = (node: Node) => node.type === 'tableCell' || (isJsx(node) && (node.name === 'td' || node.name === 'th'));
const isCodeVariable = (node: Node) =>
  isJsx(node) && node.name === 'Variable' && !!node.attributes?.some((a) => a.type === 'mdxJsxAttribute' && a.name === 'code');

export default function tableCodeBreaks() {
  return (tree: Node) => {
    const walk = (node: Node, inCell: boolean): void => {
      if (!node.children) return;
      const cell = inCell || isCell(node);
      if (cell && isCodeVariable(node)) node.attributes!.push({type: 'mdxJsxAttribute', name: 'breaks'});
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
