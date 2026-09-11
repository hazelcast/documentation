import ComponentTypes from '@theme-original/NavbarItem/ComponentTypes';
import NavbarCta from '@site/src/components/NavbarCta';
import NavbarAskAi from '@site/src/components/NavbarAskAi';

// Register a custom navbar item type so config can place a real React
// component (the HIVE Button) in themeConfig.navbar.items via
// `{type: 'custom-cta'}`.
export default {
  ...ComponentTypes,
  'custom-cta': NavbarCta,
  'custom-ask-ai': NavbarAskAi,
};
