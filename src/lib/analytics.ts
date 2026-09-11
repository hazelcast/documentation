declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

// One push into GTM's dataLayer, shaped `{event, ...params}` — the same shape
// the container's existing custom-event triggers already listen for.
//
// Safe to call anywhere, in any environment: the array is created on demand, and
// GTM is not required for the push to succeed. Where no container is loaded (dev,
// previews) the entries simply accumulate unread.
export function pushDataLayer(
  event: string,
  params: Record<string, unknown> = {},
): void {
  (window.dataLayer = window.dataLayer ?? []).push({event, ...params});
}
