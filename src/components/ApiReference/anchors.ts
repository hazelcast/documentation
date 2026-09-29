import {menuItemAnchor} from '@site/plugins/lib/api-anchors';

// Shared with plugins/lib/api-anchors.js: the plugin registers these anchors for onBrokenAnchors and this renders them, so they must agree.
export function anchorFor(item: {type?: string; httpVerb?: string; path?: string; id: string}): string {
  return menuItemAnchor(item);
}
