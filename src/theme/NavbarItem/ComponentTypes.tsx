import ComponentTypes from '@theme-original/NavbarItem/ComponentTypes';
import NavbarCta from '@site/src/components/NavbarCta';
import NavbarAskAi from '@site/src/components/NavbarAskAi';

// Registers a `custom-cta` navbar item type so config can place the HIVE Button in navbar items.
export default {
  ...ComponentTypes,
  'custom-cta': NavbarCta,
  'custom-ask-ai': NavbarAskAi,
};
