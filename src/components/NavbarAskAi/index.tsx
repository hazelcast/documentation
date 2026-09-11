import type {ReactNode} from 'react';
import {Button} from '@hazelcast/ui/lib/components/Button';
import AskAiIcon from './AskAiIcon';

// "Ask AI" navbar button, registered as the `custom-ask-ai` navbar item type
// (see src/theme/NavbarItem/ComponentTypes.tsx) and placed next to the search
// bar in docusaurus.config.ts. Same shape as NavbarCta.
//
// The widget is loaded with `data-button-hide`, so its own floating launcher
// never appears and this is the only way in. `window.Kapa` is a queueing stub
// from the moment src/clientModules/kapa.ts runs, so a click that lands before
// the bundle finishes downloading is replayed rather than lost -- which is why
// this calls it unconditionally rather than checking for the real widget.
// `mobile` is passed by the burger sidebar, which renders its items into a
// <ul class="menu__list">. A bare <button> there is invalid markup and lays out
// as an inline pill rather than a menu row, so the mobile form supplies its own
// <li> and fills the width. Below Infima's 996px breakpoint the navbar copy is
// hidden in custom.css, leaving this as the only one on screen.
export default function NavbarAskAi({mobile}: {mobile?: boolean}): ReactNode {
  if (mobile) {
    return (
      <li className="menu__list-item">
        <Button
          variant="contained"
          color="secondary"
          iconLeft={AskAiIcon}
          iconLeftAriaLabel="Ask AI"
          className="navbar-ask-ai"
          fullWidth
          onClick={() => window.Kapa?.('open')}
        >
          Ask AI
        </Button>
      </li>
    );
  }
  return (
    <Button
      variant="contained"
      color="secondary"
      iconLeft={AskAiIcon}
      iconLeftAriaLabel="Ask AI"
      className="navbar-ask-ai"
      onClick={() => window.Kapa?.('open')}
    >
      Ask AI
    </Button>
  );
}
