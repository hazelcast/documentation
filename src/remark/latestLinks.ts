// Resolve `/<component>/latest/...` links to the version segment that alias
// currently points at, at MDX compile time.
//
// WHY THESE LINKS EXIST. Antora resolves a versionless cross-component xref to
// the target component's latest version and bakes the number into the HTML
// (`/hazelcast/5.7/...`), which rots the moment that component ships a release.
// The converter therefore rewrites it to `/<comp>/latest/...`
// (floatCrossComponentLatest in migration/converter/lib/html-to-mdx.js), which on
// production is a Netlify 307 splat in hazelcast-docs `_redirects`.
//
// WHY THEY NEED REWRITING HERE. That alias is host infrastructure, not a route.
// Docusaurus's broken-link checker is handed only `routes`
// (core/lib/commands/build/buildLocale.js), so `/hazelcast/latest/...` is
// reported broken however faithfully the host serves it — 505 warnings, which is
// noise dense enough to bury a real one. Client redirects cannot fix that either:
// plugin-client-redirects runs in `postBuild` and writes files straight to the
// output, never registering a route, so the checker cannot see those either.
//
// Rewriting the href to the real version segment makes the link resolve for the
// checker rather than merely silencing it, and the anchor half of a
// `/latest/page#frag` link becomes checkable for the first time (until now the
// whole path was broken, so the fragment was never even looked at).
//
// Resolved at COMPILE time, not baked by the converter: the map comes from
// <id>_versions.json on every build, so a version cut re-points every one of
// these links with no content change. The page source keeps the readable,
// greppable `/latest/` form.
//
// NOT handled, deliberately: hardcoded absolute
// `https://docs.hazelcast.com/<comp>/latest/...` URLs. Those are external links
// by the time they reach here, are a known pre-existing bug (~70 corpus-wide),
// and are a separate post-migration content fix.

// Minimal shapes, so this stays dependency-free. `unist-util-visit` would do the
// walk (Docusaurus's own remark plugins use it, reaching the ESM-only package
// from CJS via `await import()`), but we only have it as a TRANSITIVE dep of
// mdx-loader — importing it directly means declaring it in package.json and
// pinning ourselves to a tree we do not own. For a two-node-type walk over an
// already-parsed tree, the six lines below are the cheaper side of that trade.
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

// `/comp/latest` with no trailing path is the component root, which Antora's
// alias serves as the version root — hence the '/' default. Any `#frag` or
// `?query` rides along inside `rest` untouched: it is the referrer's content,
// not ours to rewrite.
//
// Exported because the remark plugin is not the only caller: the landing page
// (src/pages/index.tsx) is a React page, so its card links never pass through
// MDX and have to resolve the same alias themselves. One rule, one place — a
// second copy of the regex is how the two drift apart.
export function resolveLatest(url: string, latest: LatestSegs): string | null {
  const m = LATEST_RE.exec(url);
  if (!m) return null;
  const seg = latest[m[1]];
  if (!seg) return null;
  return `/${m[1]}/${seg}${m[2] ?? '/'}`;
}

export default function latestLinks({latest}: {latest: LatestSegs}) {
  // `latest` is held by REFERENCE and read here, per file, during the build —
  // long after config evaluation has run every versionedDocs() call that fills
  // it. That matters because the instances are constructed one at a time, so the
  // map is still incomplete when the first instance attaches this plugin.
  return (tree: Node) => {
    const walk = (node: Node): void => {
      // A Markdown link. These are the 505: the theme renders them through
      // <Link>, which is what collects the href for the checker.
      if (node.type === 'link' && typeof node.url === 'string') {
        const to = resolveLatest(node.url, latest);
        if (to) node.url = to;
      }

      // A raw `<a href="…">`, which the converter emits where a {attr}
      // reference in the label became a <Variable/> — MDX cannot parse a
      // component inside a `[…]` label. jsxAttr() emits a plain quoted string,
      // so the attribute value is a string rather than an expression. No such
      // link currently resolves to a `/latest/` target (193 raw <a href> in the
      // converted corpus, none of them floated), so this arm is defensive: it
      // costs two lines and stops that combination from silently regressing.
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
