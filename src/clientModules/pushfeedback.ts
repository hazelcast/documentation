import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

// Defines the PushFeedback widget's custom elements, once per SPA session.
//
// The button itself is rendered by src/components/FeedbackButton, in the docs
// TOC rail (src/theme/DocItem/Layout). This module only has to make
// <feedback-modal> a real element; registration is global and idempotent, so
// it belongs here rather than in the component, which mounts and unmounts on
// every navigation.
//
// Imported from `pushfeedback/dist/components/…` — Stencil's custom-elements
// output — rather than the vendor's Docusaurus plugin, for two reasons. The
// plugin appends the button to `document.body` and offers no way not to, which
// cannot place anything in the rail; and it loads the bundle from jsDelivr at
// `@latest` by default, whereas importing it makes the widget an ordinary
// pinned dependency that webpack bundles and fingerprints with everything else.
// No third-party request is involved in showing the button at all now.
//
// Only <feedback-modal> is registered: the trigger is HIVE's own Button, which
// calls the modal's openModal() (see the component). The modal pulls in
// canvas-editor itself, so this one element is enough.

if (ExecutionEnvironment.canUseDOM) {
  void import('pushfeedback/dist/components/feedback-modal').then(
    ({defineCustomElement}) => {
      defineCustomElement();
    },
  );
}
