// Undo the extra HTML escaping Docusaurus applies to a local Markdown image's
// alt and title.
//
// @docusaurus/mdx-loader's transformImage (3.10.2) turns `![alt](./x.png)` into
// a JSX `<img>` and sets `alt` to `escapeHtml(node.alt)`. A JSX attribute value is
// already text, and React escapes it again when rendering, so the built page
// carries `alt="the name &amp;#39;hello&amp;#39;"` and a screen reader reads
// the entity out. Found by fidelity Layer 2's `imageAlts` comparison: 20 pages
// across Platform versions, every one of them an alt containing ' or <.
//
// This runs after the default plugins (it is registered in `remarkPlugins`,
// which mdx-loader appends after transformImage) and reverses exactly one
// escape-html pass. It only touches transformImage's output: an `<img>` whose
// `src` is a `require(...)` expression. Remote images are not transformed and
// render correctly, and the converted corpus writes no JSX `<img>` of its own.
//
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

// One pass over the five entities escape-html emits, in a single regex so an
// escaped `&amp;lt;` decodes to `&lt;` and not on to `<`.
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
