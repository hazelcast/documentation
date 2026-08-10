import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// Minimal placeholder landing page for the migration. Replace with a real
// homepage once more components are migrated; for now it just points at the
// first migrated component (Cloud).
export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <main style={{padding: '4rem 1rem', textAlign: 'center'}}>
        <h1>{siteConfig.title}</h1>
        <p>{siteConfig.tagline}</p>
        Placeholder
      </main>
    </Layout>
  );
}
