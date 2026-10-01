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
      };
    }
  }
}

export default function FeedbackButton(): ReactNode {
  const modal = useRef<FeedbackModalElement>(null);
  // Client-only: the portal needs a DOM to target.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
          />,
          document.body,
        )}
    </>
  );
}
