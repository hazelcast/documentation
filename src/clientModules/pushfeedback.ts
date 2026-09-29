import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

// Defines the PushFeedback <feedback-modal> element once per SPA session (registration is
// global and idempotent; the button is src/components/FeedbackButton).
// Imported from the bundled package rather than the vendor's Docusaurus plugin, which appends
// the button to document.body and loads from jsDelivr at `@latest`; this keeps it a pinned,
// bundled dependency with no third-party request just to show the button.

if (ExecutionEnvironment.canUseDOM) {
  void import('pushfeedback/dist/components/feedback-modal').then(
    ({defineCustomElement}) => {
      defineCustomElement();
    },
  );
}
