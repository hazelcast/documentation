import React, {useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@hazelcast/ui/lib/components/Button';
import {Edit3} from 'react-feather';

import 'pushfeedback/dist/pushfeedback/pushfeedback.css';

// Docs feedback button in the right-hand rail, rendered by src/theme/DocItem/Layout (which guarantees the
// rail exists even on pages with no headings). The trigger is HIVE's Button calling <feedback-modal>.openModal().
//
// The modal is portalled to document.body and MUST stay there: the rail is `position: sticky`, and its
// stacking context would trap the drawer's z-index beneath the navbar.
//
// Privacy: nothing here holds an IP address. Three attributes below are privacy decisions, not styling:
//   fetch-data="false"  Stops the widget contacting app.pushfeedback.com on every page view (it now only
//     does so on submit). Dashboard-side reCAPTCHA can then no longer reach the widget.
//   custom-font="true"  Stops it injecting a Google Fonts <link>; it inherits the site font instead.
//   hide-email="true"   No email field: it is the one direct identifier the widget collects.
// Using the widget's own <feedback-button> would also write a persistent `pushfeedback_sessionid` to localStorage.

const PROJECT = '3m7dkbl46s';

// The footer note as HIVE help text. The widget centres it at 11px #666 inside its shadow root, with no variable or
// exposed part for the inner element, and its sanitizer strips `style`. Safe to target its classes: the package is pinned.
// `:host` outranks the widget's own sheet, which it adopts after this one.
const FOOTER_CSS = `:host .feedback-modal-footer, :host .feedback-footer-combined {
  text-align: start;
  font-size: var(--hive-font-size-body-smaller);
  color: var(--hive-color-text-secondary-v4);
}`;

type FeedbackModalElement = HTMLElement & {
  openModal?: () => Promise<void>;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'feedback-modal': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        FeedbackModalElement
      > & {
        project: string;
        'modal-position'?: string;
        'fetch-data'?: string;
        'custom-font'?: string;
        'hide-email'?: string;
        'footer-text'?: string;
      };
    }
  }
}

export default function FeedbackButton(): ReactNode {
  const modal = useRef<FeedbackModalElement>(null);
  // Client-only: the portal needs a DOM to target.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    void customElements.whenDefined('feedback-modal').then(() => {
      const root = modal.current?.shadowRoot;
      if (!root) return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(FOOTER_CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    });
  }, [mounted]);

  return (
    <>
      <Button
        variant="outlined"
        color="secondary"
        fullWidth
        iconLeft={Edit3}
        iconLeftAriaLabel="Feedback"
        onClick={() => {
          // Optional-called: a click before the widget chunk loads is dropped rather than throwing.
          void modal.current?.openModal?.();
        }}>
        Feedback
      </Button>
      {mounted &&
        createPortal(
          <feedback-modal
            ref={modal}
            project={PROJECT}
            modal-position="sidebar-right"
            fetch-data="false"
            custom-font="true"
            hide-email="true"
            // Shown under Send. "Add a screenshot" triggers the browser's screen-capture prompt, which readers don't expect.
            footer-text="To add a screenshot, your browser needs permission to capture your screen. Choose this tab. You can mark up the screenshot before you attach it, and nothing is sent until you select Send."
          />,
          document.body,
        )}
    </>
  );
}
