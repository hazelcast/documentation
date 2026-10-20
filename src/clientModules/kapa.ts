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
  'data-project-logo': '/img/kapa/ask-ai-icon.svg',
  // Follow the site's theme toggle: Kapa re-matches this against <html> whenever `data-theme` changes.
  'data-color-scheme-selector': "[data-theme='dark']",
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
  // Telegraf's capitals sit high in a centred line box: 1px in Chrome, 3px in Firefox (different vertical metrics).
  // The header centres the padded box, so 4px leaves each browser 1px off centre, in opposite directions.
  'data-modal-title-padding-top': '4px',
  // No header icon: it is a fixed-colour image, and Kapa has no dark-mode logo to swap in.
  'data-modal-image-hide': 'true',
  'data-modal-disclaimer':
    "This is an experimental custom LLM for answering technical questions about Hazelcast. Answers are based **only** on Hazelcast documentation and support sources, but may not be fully accurate so please use your best judgement. Don't forget to rate the answers and give feedback!",
  'data-modal-example-questions':
    'How do I get started with Hazelcast?,What are Enterprise-only features?,What is the best serialization strategy?,What is the CP Subsystem?',
  'data-search-mode-enabled': 'false',
  'data-search-display-num-results': '10',
  'data-search-source-group-order':
    '["docs.hazelcast.com", "Java API Docs", "C# API Docs", "Go Client Docs"]',
};

// Kapa attributes with a `-dark` twin, and the HIVE v4 colour each follows.
const SCHEMED: Record<string, string> = {
  'data-project-color': 'brand',
  'data-surface-color': 'neutral-white',
  'data-surface-elevated-color': 'neutral-lighter',
  'data-surface-hover-color': 'surface-hover',
  'data-text-color': 'text',
  'data-text-muted-color': 'text-secondary',
  'data-border-color': 'border',
  'data-anchor-color': 'link',
};

// Kapa takes literal values, not `var(--hive-...)`, so HIVE tokens are resolved once at load. HIVE's v4 colours are
// `light-dark()` pairs; each half is also its own token (`-light-mode`/`-dark-mode`), read here per scheme.
// If the stylesheet hasn't loaded, nothing is set and Kapa keeps its defaults.
function resolveThemeTokens(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();
  // Kapa's colour parser throws on `oklch()`, so plain colours go in as hex.
  const pixel = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
  const hex = (colour: string) => {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = colour;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b, ...(a < 255 ? [a] : [])].map((n) => n.toString(16).padStart(2, '0')).join('');
  };
  const light = (colour: string) => hex(token(`--hive-color-${colour}-v4-light-mode`));
  const dark = (colour: string) => hex(token(`--hive-color-${colour}-v4-dark-mode`));
  // For attributes with no `-dark` twin: Kapa's Mantine root sets `color-scheme`, which picks the half.
  const both = (colour: string) => `light-dark(${light(colour)}, ${dark(colour)})`;
  // HIVE Modal's header: 20% primary over the page background (Modal.module.css `.header`). The canvas can't parse
  // `color-mix()`, so an element's computed colour resolves it first.
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  const headerFor = (scheme: (colour: string) => string) => {
    probe.style.color = `color-mix(in oklab, ${scheme('primary')} 20%, ${scheme('neutral-lighter')})`;
    return hex(getComputedStyle(probe).color);
  };
  const header = `light-dark(${headerFor(light)}, ${headerFor(dark)})`;
  probe.remove();
  if (!token('--hive-color-text-v4-light-mode')) {
    return {};
  }
  return {
    ...Object.fromEntries(
      Object.entries(SCHEMED).flatMap(([attribute, colour]) => [
        [attribute, light(colour)],
        [`${attribute}-dark`, dark(colour)],
      ]),
    ),
    'data-modal-header-bg-color': header,
    'data-modal-title-color': both('text'),
    'data-modal-disclaimer-bg-color': both('surface-hover'),
    'data-modal-disclaimer-text-color': both('text-secondary'),
    'data-example-question-button-bg-color': both('neutral-white'),
    'data-example-question-button-hover-bg-color': both('surface-hover'),
    'data-example-question-button-text-color': both('text'),
    'data-example-question-button-border': `${token('--hive-border-width')} solid ${both('border')}`,
    'data-example-question-button-border-radius': token('--hive-border-radius'),
    'data-modal-border-radius': token('--hive-border-radius'),
    // Any component takes `data-{component}-{css property}`; the MCP button is otherwise a hardcoded pill.
    'data-mcp-button-border-radius': token('--hive-border-radius'),
    // Dropped straight into a CSS `font-family`, so the token's whole stack is valid.
    'data-font-family': token('--hive-font-family-text'),
    'data-modal-title-font-family': token('--hive-font-family-heading'),
    'data-modal-title-font-weight': token('--hive-font-weight-heading-bold'),
  };
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
