import {useEffect, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import styles from './privacy.module.css';

// The policy is fetched at runtime from the hazelcast.com WordPress REST API, so Legal's edits need no docs
// rebuild; the tradeoff is that it is invisible to crawlers and to readers without JavaScript.
// The fetched `<a href="#manage_cookies">` has no target here: the Enzuzo cookie bar claims that href, so no code binds it.
const POLICY_ENDPOINT = 'https://hazelcast.com/wp-json/wp/v2/pages?slug=privacy';
const POLICY_FALLBACK = 'https://hazelcast.com/privacy/';

// The payload's two unscoped <style> blocks select bare `h2` and `table` and would restyle the whole site
// (innerHTML applies <style> though not <script>), so they are stripped before injection.
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
