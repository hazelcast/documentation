import {useEffect, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import styles from './privacy.module.css';

// The policy text is deliberately NOT held in this repo. It is fetched at
// runtime from the hazelcast.com WordPress REST API, which is what the Antora
// site did too (hazelcast-docs-ui/src/layouts/privacy.hbs). Keeping the fetch
// at runtime means Legal's edits reach this page without a docs rebuild -- the
// tradeoff is that the policy is invisible to crawlers and to readers with no
// JavaScript, exactly as it is on the current site.
//
// One link inside the fetched HTML -- `<a href="#manage_cookies">` in the
// "Cookies we use" section -- has no target on this page. Enzuzo's cookiebar
// bundle claims that href and opens its preferences pane; until that script is
// loaded site-wide the link does nothing. No code here binds it, and none is
// needed once Enzuzo is added.
const POLICY_ENDPOINT = 'https://hazelcast.com/wp-json/wp/v2/pages?slug=privacy';
const POLICY_FALLBACK = 'https://hazelcast.com/privacy/';

// The payload carries two unscoped <style> blocks whose rules select bare `h2`
// and `table`, so injecting them would restyle the entire site, not just this
// page. innerHTML never runs <script>, but it does apply <style>, so both are
// stripped before injection.
function stripEmbeddedCss(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '');
}

type State =
  | {status: 'loading'}
  | {status: 'ready'; html: string}
  | {status: 'error'};

export default function Privacy(): ReactNode {
  const [state, setState] = useState<State>({status: 'loading'});

  useEffect(() => {
    const controller = new AbortController();

    fetch(POLICY_ENDPOINT, {signal: controller.signal})
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then((pages) => {
        const html = pages?.[0]?.content?.rendered;
        if (!html) {
          throw new Error('no privacy page in the API response');
        }
        setState({status: 'ready', html: stripEmbeddedCss(html)});
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        console.error('Could not load the privacy policy:', error);
        setState({status: 'error'});
      });

    return () => controller.abort();
  }, []);

  return (
    <Layout
      title="Privacy Policy"
      description="How Hazelcast collects, uses, stores and shares personal data.">
      <main className={styles.page}>
        {state.status === 'loading' && (
          <p className={styles.status}>Loading the privacy policy…</p>
        )}

        {state.status === 'error' && (
          <p className={styles.status}>
            The privacy policy could not be loaded. You can read it at{' '}
            <a href={POLICY_FALLBACK}>hazelcast.com/privacy</a>.
          </p>
        )}

        {state.status === 'ready' && (
          <div
            className={clsx('markdown', styles.policy)}
            dangerouslySetInnerHTML={{__html: state.html}}
          />
        )}
      </main>
    </Layout>
  );
}
