import {useEffect, useState, type ReactNode} from 'react';
import styles from './styles.module.css';

// Landing-page promo bar, fetched at runtime from the hazelcast.com WordPress REST API so marketing can
// change it without a docs rebuild.
// The `.promo-banner` element is injected as-is (untyped, unvalidated): whatever is inside ships. Only that
// node is taken, so a <style> beside it is dropped; `dangerouslySetInnerHTML` never executes <script>.
// Usually EMPTY: marketing comments the markup out in WordPress, so the response is a 200 with no
// `.promo-banner`. The console warning is informational.
const PROMO_ENDPOINT =
  'https://hazelcast.com/wp-json/wp/v2/pages?slug=docs-site-promo-banner';

// No element with this class means no banner.
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
        // WordPress's editor tends to emit a stray leading <br>.
        const cleaned = rendered.replace(/^\s*<br\s*\/?>/i, '').trim();
        // DOMParser, not a detached div: it never fetches subresources while parsing.
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

  // No placeholder or reserved height, so a missing banner leaves no gap (cards shift down when it loads).
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
