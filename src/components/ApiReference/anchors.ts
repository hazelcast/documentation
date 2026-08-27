import {menuItemAnchor} from '@site/plugins/lib/api-anchors';

// The anchor a menu item is published under, from Redoc's model of the spec.
//
// One line, because the definition itself lives in plugins/lib/api-anchors.js —
// the same module the build-time plugin walks the same menu with. That is
// deliberate: the plugin REGISTERS these anchors for onBrokenAnchors and this
// renders them, so a link the build validated has to be a link that resolves.
export function anchorFor(item: {type?: string; httpVerb?: string; path?: string; id: string}): string {
  return menuItemAnchor(item);
}
