import React, {useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@hazelcast/ui/lib/components/Button';
import {Edit3} from 'react-feather';

import 'pushfeedback/dist/pushfeedback/pushfeedback.css';
import styles from './styles.module.css';

// The docs feedback button, as it sits in production: in the right-hand rail,
// under the table of contents.
//
// Rendered by src/theme/DocItem/Layout, which is also what guarantees the rail
// exists on a page with no headings — Docusaurus drops the whole column when
// the TOC is empty, so hanging this off @theme/TOC would have lost it on ~690
// of our pages. The custom element is defined once per session by
// src/clientModules/pushfeedback.ts.
//
// The trigger is HIVE's own Button and the widget's <feedback-button> is not
// used at all: that one is a 20px-radius pill coloured from the widget's
// palette, and restyling it through the vendor's tokens would only ever
// approximate a HIVE button. <feedback-modal> exposes openModal(), so the
// widget supplies the modal and the site supplies the control — the same split
// as the Ask AI button, which opens Kapa with its own launcher suppressed
// (src/components/NavbarAskAi).
//
// The modal is portalled to document.body and MUST stay there. The rail it
// would otherwise render into is `position: sticky` (DocItem/Layout's
// styles.module.css), and a sticky element creates a stacking context — so the
// drawer's own z-index (300) resolved inside the rail instead of against the
// page, and the navbar (Infima's --ifm-z-index-fixed: 200) painted over the top
// of it. body is also where the vendor's own plugin appends it.
//
// Worth knowing if this is ever reverted to <feedback-button>: the random id
// the widget writes to localStorage (`pushfeedback_sessionid`) is written in
// the BUTTON's componentWillLoad, so using our own trigger means it is never
// written and submissions carry an empty `session`. That removes the one
// persistent identifier we could not configure away.
//
// The icon is Feather's edit-3, which is the exact icon the widget's own button
// carries: PushFeedback ships Feather, and its two paths match react-feather's
// Edit3 byte for byte. So dropping their button costs nothing visually.
//
// This replaces the Antora UI's Netlify-backed form, which recorded the
// submitter's IP against every submission. Nothing here holds an IP:
// PushFeedback's stored record (dashboard, REST, webhook) has no IP field, and
// with `fetch-data` off the widget contacts app.pushfeedback.com only on
// submit. Three of the attributes below are that decision, not styling:
//
//   fetch-data="false"  By default the widget GETs its project config
//     (whitelabel flag + reCAPTCHA keys) from app.pushfeedback.com in
//     componentWillLoad, so every page view would contact them before anyone
//     had interacted. The cost is that dashboard-side reCAPTCHA can no longer
//     reach the widget: turning reCAPTCHA on means turning this back on too.
//   custom-font="true"  By default the widget injects a Google Fonts <link>
//     for Inter into every page. Off, it inherits the site's HIVE stack
//     through --feedback-font-family (src/css/custom.css).
//   hide-email="true"   No email field. It is the one direct identifier the
//     widget collects, and there is no reply workflow to justify holding it.
//     The submitted `email` is then always empty.

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
  // The portal needs a DOM to target, so the modal is client-only. It renders
  // nothing visible until opened, and the trigger below is optional-called, so
  // the gap before hydration costs nothing.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className={styles.feedback}>
      <Button
        variant="outlined"
        color="secondary"
        iconLeft={Edit3}
        iconLeftAriaLabel="Feedback"
        onClick={() => {
          // Optional-called: a click that lands before the widget's chunk has
          // arrived finds an element that is not yet upgraded, and is dropped
          // rather than throwing. The chunk is small and local, so the window
          // is short — but the modal cannot be queued the way Kapa's stub
          // queues, because there is nothing to queue into.
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
    </div>
  );
}
