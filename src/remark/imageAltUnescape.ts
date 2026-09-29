// Undo the extra HTML escaping @docusaurus/mdx-loader's transformImage applies to a local image's alt/title
// (the built page would otherwise carry `&amp;#39;`).
//
// Runs after the default plugins (registered in `remarkPlugins`) and only touches transformImage output,
// i.e. an `<img>` whose `src` is a `require(...)` expression.
// Remove once Docusaurus stops escaping these values.

type Attr = {type: string; name?: string; value?: unknown};
type Node = {type: string; name?: string; attributes?: Attr[]; children?: Node[]};

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

// Single pass, so `&amp;lt;` decodes to `&lt;` and not on to `<`.
export function unescapeHtml(s: string): string {
  return s.replace(/&(?:quot|#39|lt|gt|amp);/g, (e) => ENTITIES[e]);
}

const isRequireSrc = (attr: Attr) =>
  attr.type === 'mdxJsxAttribute' &&
  attr.name === 'src' &&
  typeof attr.value === 'object' &&
  attr.value !== null &&
  (attr.value as {type?: string}).type === 'mdxJsxAttributeValueExpression' &&
  /^require\(/.test(String((attr.value as {value?: unknown}).value));

export default function imageAltUnescape() {
  return (tree: Node) => {
    const walk = (node: Node): void => {
      if (node.type === 'mdxJsxTextElement' && node.name === 'img' && (node.attributes ?? []).some(isRequireSrc)) {
        for (const attr of node.attributes ?? []) {
          if (attr.type !== 'mdxJsxAttribute' || (attr.name !== 'alt' && attr.name !== 'title')) continue;
          if (typeof attr.value === 'string') attr.value = unescapeHtml(attr.value);
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
