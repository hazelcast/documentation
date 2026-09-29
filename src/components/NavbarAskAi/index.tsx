import type {ReactNode} from 'react';
import {Button} from '@hazelcast/ui/lib/components/Button';
import AskAiIcon from './AskAiIcon';

// "Ask AI" navbar button (`custom-ask-ai` item type); the widget's own launcher is hidden, so this is the only way in.
// `window.Kapa` is a queueing stub from kapa.ts, so an early click is replayed; hence the unconditional call.
// `mobile` is passed by the burger sidebar, so that form brings its own <li>; the navbar copy is hidden below 996px in custom.css.
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
