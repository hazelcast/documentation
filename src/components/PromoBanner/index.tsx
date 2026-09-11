import {useEffect, useState, type ReactNode} from 'react';
import styles from './styles.module.css';

// The landing page's promo bar, fetched at runtime from the hazelcast.com
// WordPress REST API — the same endpoint and the same extraction the Antora
// site used (hazelcast-docs-ui/src/partials/body-home.hbs). Keeping it at
// runtime is the whole point: marketing edits the WP page and the bar changes
// with no docs rebuild, which is why the content is not in this repo.
//
// MARKUP IS WORDPRESS'S, VERBATIM. The payload's `.promo-banner` element is
// lifted out and injected as-is rather than being read field-by-field and
// re-rendered here. That is a deliberate choice (Miranda, this migration): it
// reproduces production exactly and survives marketing restructuring the bar,
// where a field-reading component would silently render nothing the first time
// they changed its shape. The cost is that the markup is untyped and unvalidated
// — whatever is inside `.promo-banner` is what ships.
//
// Injecting remote HTML follows the precedent already set by /privacy, which
// does the same with the policy text from the same WordPress install. Note that
// `dangerouslySetInnerHTML`, like `innerHTML`, never executes <script> — and
// because only the `.promo-banner` node is taken, any <style> block sitting
// beside it in the payload is dropped rather than applied site-wide (the bug
// /privacy has to strip for explicitly).
//
// This endpoint IS reachable cross-origin (verified from localhost against the
// live site), unlike the privacy one — so the bar works on the dev server and on
// previews, not only in production.
//
// It is nevertheless usually EMPTY. Marketing turns the bar off by commenting the
// markup out in the WordPress editor rather than by clearing the page, so the
// response stays a 200 carrying an HTML comment and no `.promo-banner` element.
// That is the normal resting state — the console warning below is informational,
// and an empty slot is not a failure.
const PROMO_ENDPOINT =
  'https://hazelcast.com/wp-json/wp/v2/pages?slug=docs-site-promo-banner';

// The class WordPress wraps the bar in, and our contract with that page: no
// element with this class means no banner, and the slot stays empty.
const PROMO_SELECTOR = '.promo-banner';

export default function PromoBanner(): ReactNode {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch(PROMO_ENDPOINT, {signal: controller.signal})
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then((pages) => {
        const rendered = pages?.[0]?.content?.rendered;
        if (!rendered) {
          console.warn('Promo banner content not found.');
          return;
        }
        // WordPress's editor tends to emit a stray leading <br>; production
        // strips the same one before parsing.
        const cleaned = rendered.replace(/^\s*<br\s*\/?>/i, '').trim();
        // DOMParser rather than a detached div: it never fetches subresources
        // while parsing, so an <img> in the payload cannot hit the network
        // before the node is on the page.
        const doc = new DOMParser().parseFromString(cleaned, 'text/html');
        const banner = doc.querySelector(PROMO_SELECTOR);
        if (!banner) {
          console.warn(`No ${PROMO_SELECTOR} found in fetched content.`);
          return;
        }
        setHtml(banner.outerHTML);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        console.error('Failed to load promo banner:', error);
      });

    return () => controller.abort();
  }, []);

  // Nothing rendered until the bar arrives — no placeholder and no reserved
  // height, so a missing or failed banner leaves no gap. Production behaves the
  // same way; the tradeoff is that the cards shift down when it does load.
  if (!html) {
    return null;
  }

  return (
    <div
      className={styles.host}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{__html: html}}
    />
  );
}
