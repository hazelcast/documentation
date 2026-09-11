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
export default function NavbarAskAi(): ReactNode {
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
