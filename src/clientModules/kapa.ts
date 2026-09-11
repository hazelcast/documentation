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

// The Kapa AI widget ("Ask AI").
//
// Not gated on NODE_ENV the way the GTM container is: the widget is a feature of
// the site rather than analytics, so it loads on the dev server too. Off
// production it finds no consent cookie and loads cookieless, which is the safe
// direction.

const WIDGET_SRC = 'https://widget.kapa.ai/kapa-widget.bundle.js';
const KAPA_COOKIE = 'kapa_web_id';

const CONFIG: Record<string, string> = {
  'data-website-id': '6b326171-dd1e-40c6-a948-1f9bb6c0ed52',
  'data-project-name': 'Hazelcast',
  // A static/ asset. Its white fill is baked into the file: it renders on the
  // teal modal header.
  'data-project-logo': '/img/kapa/ask-ai-icon.svg',
  // Suppress the widget's own floating launcher: the navbar button is the way
  // in (src/components/NavbarAskAi).
  'data-button-hide': 'true',
  'data-mcp-enabled': 'true',
  'data-mcp-server-url': 'https://hazelcast.mcp.kapa.ai',
  // NO `data-modal-z-index`. Kapa applies it to the modal layer alone, leaving
  // Mantine's popover layer at its default (--mantine-z-index-modal: 200,
  // --mantine-z-index-popover: 300), so any value above 300 renders every
  // tooltip inside the modal UNDERNEATH it. Omitting it keeps Mantine's own
  // ordering intact; the height needed to clear the site navbar is applied to
  // the widget's HOST instead, in custom.css.
  'data-modal-size': '800px',
  // One value for every page: the widget loads once per SPA session, so this
  // cannot vary by route. 70px clears the navbar.
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

// Kapa takes literal values in its data-* attributes -- it cannot consume
// `var(--hive-...)`. So the HIVE tokens are resolved off the document element and
// their computed values handed over.
//
// Resolving ONCE, at load, is safe rather than a shortcut: HIVE's variables.css
// declares its colour tokens only on `:root` with no dark variant, and this
// site's [data-theme='dark'] block redefines Infima `--ifm-*` vars exclusively.
// The values do not vary with the theme, so a widget configured at load never
// drifts out of step with the page.
//
// Each fallback is its token's current value, so a stylesheet that has not
// applied yet still leaves the modal rendering correctly.
const THEMED: Record<string, [token: string, fallback: string]> = {
  'data-project-color': ['--hive-color-brand-secondary', '#061727'],
  'data-modal-header-bg-color': ['--hive-color-brand-text', '#10a4b3'],
  'data-modal-title-color': ['--hive-color-neutral-white', '#fff'],
  'data-modal-disclaimer-bg-color': ['--hive-color-neutral-white', '#fff'],
  'data-modal-disclaimer-text-color': ['--hive-color-text-secondary', '#707482'],
  // Kapa drops this straight into a CSS `font-family`, so the token's whole
  // stack is valid here -- verified against the rendered title's computed style
  // inside the widget's shadow root.
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

// Enzuzo writes `cookies-analytics=true` when analytics consent is granted. It
// does so however the banner itself was loaded, which is what lets this work
// against the container-managed Enzuzo without the site knowing it exists.
function analyticsGranted(): boolean {
  return /(?:^|;\s*)cookies-analytics=true(?:;|$)/.test(document.cookie);
}

// Kapa's own identifier cookie. It can outlive a withdrawal of consent, so it is
// cleared explicitly. The domain walk covers every scope the cookie could have
// been set at, because a cookie can only be deleted from the exact domain that
// set it and we do not know which that was.
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

// A queueing stub, so a click on the navbar button before the bundle finishes
// downloading is replayed instead of throwing. The real widget drains `q`.
function installStub(): void {
  if (window.Kapa) {
    return;
  }
  const stub = ((...args: unknown[]) => {
    stub.c!(args);
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
  // Kapa resolves its analytics mode from this attribute once, at init. Note the
  // default: an ABSENT attribute means cookies are enabled, so consent has to be
  // expressed by actively passing `false`.
  script.setAttribute(
    'data-user-analytics-cookie-enabled',
    analyticsGranted() ? 'true' : 'false',
  );
  document.head.appendChild(script);
}

// Consent can be withdrawn after the widget has already set its cookie, and the
// mode above is fixed at init with no runtime setter -- so clearing the cookie is
// the only lever short of reloading the page.
//
// `cookies-analytics` is the source of truth, and watching it directly keeps this
// independent of GTM. The alternative signal, Enzuzo's `enzuzo_consent_update`
// dataLayer event, is only observable by wrapping a `push` that GTM replaces when
// the container initialises, and GTM does not load off production at all. Enzuzo
// publishes nothing to subscribe to: there is no CustomEvent anywhere in its
// bundle.
//
// This module runs once per SPA session rather than once per page, so a reader
// can keep browsing for a long time after withdrawing consent. Closing that
// window is the whole job of the watcher.
//
// Only withdrawal is actionable. Consent GRANTED mid-session cannot switch Kapa's
// cookie back on, because the mode was fixed at init; that waits for the reader's
// next full page load.
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

  // Chromium fires this for same-document cookie writes, which is how Enzuzo
  // sets it; Safari and Firefox have no Cookie Store API, so they fall back to a
  // string compare on an interval. Read off Partial<Window> because lib.dom
  // declares `cookieStore` as always present, which those browsers disprove.
  const {cookieStore} = window as Partial<Window>;
  if (cookieStore) {
    cookieStore.addEventListener('change', check);
  } else {
    setInterval(check, CONSENT_POLL_MS);
  }
}

if (ExecutionEnvironment.canUseDOM) {
  installStub();
  // Straight after the stub, so the callbacks are queued and replayed when the
  // widget drains the queue.
  registerKapaAnalytics();
  if (!analyticsGranted()) {
    deleteKapaCookie();
  }
  loadWidget();
  watchConsent();
}
