import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';
import {registerKapaAnalytics} from './kapaAnalytics';

declare global {
  interface Window {
    Kapa?: ((...args: unknown[]) => void) & {
      q?: unknown[][];
      c?: (args: unknown[]) => void;
    };
  }
}

// Kapa AI widget. Loads on the dev server too (not gated on NODE_ENV); with no consent cookie it loads cookieless.
// The bundle (~2 MB plus reCAPTCHA) loads on the first `Kapa('open')`, not on page load.

const WIDGET_SRC = 'https://widget.kapa.ai/kapa-widget.bundle.js';
const KAPA_COOKIE = 'kapa_web_id';

const CONFIG: Record<string, string> = {
  'data-website-id': '6b326171-dd1e-40c6-a948-1f9bb6c0ed52',
  'data-project-name': 'Hazelcast',
  // White fill is baked in: it renders on the teal modal header.
  'data-project-logo': '/img/kapa/ask-ai-icon.svg',
  // Hide the floating launcher; the navbar button opens the widget.
  'data-button-hide': 'true',
  'data-mcp-enabled': 'true',
  'data-mcp-server-url': 'https://hazelcast.mcp.kapa.ai',
  // No `data-modal-z-index`: it only raises the modal layer, not Mantine's popover layer,
  // which would put tooltips inside the modal underneath it. Navbar clearance is set on the host in custom.css.
  'data-modal-size': '800px',
  // Widget loads once per SPA session, so this cannot vary by route.
  'data-modal-y-offset': '70px',
  'data-modal-title': 'Ask AI',
  'data-modal-title-font-size': '24px',
  'data-modal-title-font-weight': '400',
  'data-modal-image-width': '34',
  'data-modal-image-height': '34',
  'data-modal-disclaimer':
    "This is an experimental custom LLM for answering technical questions about Hazelcast. Answers are based **only** on Hazelcast documentation and support sources, but may not be fully accurate so please use your best judgement. Don't forget to rate the answers and give feedback!",
  'data-modal-example-questions':
    'How do I get started with Hazelcast?,What are Enterprise-only features?,What is the best serialization strategy?,What is the CP Subsystem?',
  'data-search-mode-enabled': 'false',
  'data-search-display-num-results': '10',
  'data-search-source-group-order':
    '["docs.hazelcast.com", "Java API Docs", "C# API Docs", "Go Client Docs"]',
};

// Kapa takes literal values, not `var(--hive-...)`, so HIVE tokens are resolved once at load
// (safe: they don't vary with theme). Fallbacks apply if the stylesheet hasn't loaded yet.
const THEMED: Record<string, [token: string, fallback: string]> = {
  'data-project-color': ['--hive-color-brand-secondary', '#061727'],
  'data-modal-header-bg-color': ['--hive-color-brand-text', '#10a4b3'],
  'data-modal-title-color': ['--hive-color-neutral-white', '#fff'],
  'data-modal-disclaimer-bg-color': ['--hive-color-neutral-white', '#fff'],
  'data-modal-disclaimer-text-color': ['--hive-color-text-secondary', '#707482'],
  // Dropped straight into a CSS `font-family`, so the token's whole stack is valid.
  'data-modal-title-font-family': [
    '--hive-font-family-heading',
    "'PP Telegraf', 'Helvetica', 'Arial', sans-serif",
  ],
};

function resolveThemeTokens(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(THEMED).map(([attribute, [token, fallback]]) => [
      attribute,
      root.getPropertyValue(token).trim() || fallback,
    ]),
  );
}

// Enzuzo writes `cookies-analytics=true` on analytics consent, however the banner was loaded.
function analyticsGranted(): boolean {
  return /(?:^|;\s*)cookies-analytics=true(?:;|$)/.test(document.cookie);
}

// Kapa's identifier cookie can outlive a consent withdrawal. Walk every possible domain scope,
// since a cookie can only be deleted from the domain that set it.
function deleteKapaCookie(): void {
  if (!document.cookie.includes(`${KAPA_COOKIE}=`)) {
    return;
  }
  const host = location.hostname;
  const parts = host.split('.');
  const domains = ['', host];
  for (let i = 0; i < parts.length - 1; i++) {
    domains.push(`.${parts.slice(i).join('.')}`);
  }
  for (const domain of domains) {
    document.cookie =
      `${KAPA_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/` +
      (domain ? `; domain=${domain}` : '');
  }
}

// Queueing stub: the first `open` loads the bundle, which replays the queue (callbacks, then the open).
let widgetRequested = false;

function installStub(): void {
  if (window.Kapa) {
    return;
  }
  const stub = ((...args: unknown[]) => {
    stub.c!(args);
    if (args[0] === 'open' && !widgetRequested) {
      widgetRequested = true;
      loadWidget();
    }
  }) as NonNullable<Window['Kapa']>;
  stub.q = [];
  stub.c = (args: unknown[]) => {
    stub.q!.push(args);
  };
  window.Kapa = stub;
}

function loadWidget(): void {
  const script = document.createElement('script');
  script.async = true;
  script.src = WIDGET_SRC;
  for (const [name, value] of Object.entries({...CONFIG, ...resolveThemeTokens()})) {
    script.setAttribute(name, value);
  }
  // Read once, at first open. An ABSENT attribute means cookies are enabled, so pass `false` explicitly.
  script.setAttribute(
    'data-user-analytics-cookie-enabled',
    analyticsGranted() ? 'true' : 'false',
  );
  document.head.appendChild(script);
}

// Cookie mode is fixed at init, so clearing the cookie on consent withdrawal is the only lever short of a reload.
// Watches `cookies-analytics` directly, independent of GTM (absent off production).
// Consent granted mid-session cannot re-enable the cookie; it waits for the next page load.
const CONSENT_POLL_MS = 2000;

function watchConsent(): void {
  let granted = analyticsGranted();
  const check = () => {
    const current = analyticsGranted();
    if (current === granted) {
      return;
    }
    granted = current;
    if (!current) {
      deleteKapaCookie();
    }
  };

  // Chromium fires this for same-document cookie writes; Safari/Firefox lack the Cookie Store API, so poll.
  // Partial<Window> because lib.dom declares `cookieStore` as always present.
  const {cookieStore} = window as Partial<Window>;
  if (cookieStore) {
    cookieStore.addEventListener('change', check);
  } else {
    setInterval(check, CONSENT_POLL_MS);
  }
}

if (ExecutionEnvironment.canUseDOM) {
  installStub();
  // After the stub, so callbacks are queued and replayed.
  registerKapaAnalytics();
  if (!analyticsGranted()) {
    deleteKapaCookie();
  }
  watchConsent();
}
