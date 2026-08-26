import {operationAnchor} from '@site/plugins/lib/api-anchors';

// The anchor a menu item is published under, from Redoc's model of the spec.
//
// An OPERATION gets the readable method+path slug (plugins/lib/api-anchors.js) —
// the same string the build-time plugin registers from the spec document, so a
// link Docusaurus validated is a link that resolves. Anything else — a tag group,
// or a heading inside a spec's description — keeps Redoc's own id, which is
// already readable (`section/…`, `tag/…`) and, unlike an operation's, has no
// path and verb to derive a better one from.
export function anchorFor(item: {type?: string; httpVerb?: string; path?: string; id: string}): string {
  return item.type === 'operation' && item.httpVerb && item.path
    ? operationAnchor(item.httpVerb, item.path)
    : item.id;
}
