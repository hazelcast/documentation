// Resolve `/<component>/latest/...` links to the version segment the alias currently points at, at MDX compile time.
//
// Docusaurus's broken-link checker only sees routes, so the host-level `/latest/` alias is reported broken.
// Resolved at compile time (not baked) so a version cut re-points every link with no content change.
// Hardcoded absolute `https://docs.hazelcast.com/<comp>/latest/...` URLs are external and not handled.

// Minimal node shape; avoids a direct dependency on unist-util-visit (only transitive here).
type Node = {
  type: string;
  url?: string;
  name?: string;
  attributes?: {type: string; name?: string; value?: unknown}[];
  children?: Node[];
};

/** component id -> the version segment its `/latest/` alias resolves to */
export type LatestSegs = Record<string, string>;

const LATEST_RE = /^\/([^/]+)\/latest(\/.*)?$/;

// `/comp/latest` alone is the component root, hence the '/' default; `#frag`/`?query` ride along in `rest`.
// Exported because the landing page (a React page, not MDX) resolves the same alias.
export function resolveLatest(url: string, latest: LatestSegs): string | null {
  const m = LATEST_RE.exec(url);
  if (!m) return null;
  const seg = latest[m[1]];
  if (!seg) return null;
  return `/${m[1]}/${seg}${m[2] ?? '/'}`;
}

export default function latestLinks({latest}: {latest: LatestSegs}) {
  // `latest` is held by reference and read per file: it is still being filled when this plugin attaches.
  return (tree: Node) => {
    const walk = (node: Node): void => {
      // Markdown link.
      if (node.type === 'link' && typeof node.url === 'string') {
        const to = resolveLatest(node.url, latest);
        if (to) node.url = to;
      }

      // Raw `<a href>` (emitted where a label contains <Variable/>); defensive, no current link hits it.
      if (
        (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') &&
        node.name === 'a'
      ) {
        for (const attr of node.attributes ?? []) {
          if (attr.type !== 'mdxJsxAttribute' || attr.name !== 'href') continue;
          if (typeof attr.value !== 'string') continue;
          const to = resolveLatest(attr.value, latest);
          if (to) attr.value = to;
        }
      }

      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
