declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

// Push `{event, ...params}` to GTM's dataLayer; safe with no container loaded.
export function pushDataLayer(
  event: string,
  params: Record<string, unknown> = {},
): void {
  (window.dataLayer = window.dataLayer ?? []).push({event, ...params});
}
