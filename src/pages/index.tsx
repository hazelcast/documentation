import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {Card} from '@hazelcast/ui/lib/components/Card';
import PromoBanner from '@site/src/components/PromoBanner';
import {resolveLatest, type LatestSegs} from '../remark/latestLinks';
import styles from './index.module.css';

// Site landing page (`/`; `/home` redirects here via client-redirects in docusaurus.config.ts). It has no
// source content page, so the cards live here. The navbar carries search and Ask AI, so they are not repeated.

type CardLink = {label: string; to: string};

/**
 * A `/<component>/latest/...` href is resolved to the real version segment at
 * render (see resolveLatest). Written in the `/latest/` form on purpose: it
 * survives a version cut with no edit here, and it stays greppable against the
 * same alias in the MDX corpus.
 */
const CARDS: {title: string; links: CardLink[]}[] = [
  {
    title: 'Get started',
    links: [
      {label: 'What is Hazelcast Platform?', to: '/hazelcast/latest/what-is-hazelcast'},
      {label: 'Start a local cluster', to: '/hazelcast/latest/getting-started/get-started-docker'},
      {
        label: 'Install Community Edition for free',
        to: '/hazelcast/latest/getting-started/install-hazelcast',
      },
      {label: 'Ask AI', to: '/hazelcast/latest/ask-ai'},
    ],
  },
  {
    title: 'Hazelcast Platform',
    links: [
      // Pinned to a version on purpose: the label names the release, so both must change together.
      {label: 'What\'s new in 5.7', to: '/hazelcast/5.7/whats-new'},
      {label: 'Available topologies', to: '/hazelcast/latest/deploy/choosing-a-deployment-option'},
      {label: 'Community vs. Enterprise', to: '/hazelcast/latest/getting-started/editions'},
      {label: 'Cloud deployment', to: '/hazelcast/latest/deploy/deploying-in-cloud'},
    ],
  },
  {
    title: 'Develop and build',
    links: [
      {
        label: 'Get started with a Hazelcast Client',
        to: '/hazelcast/latest/clients/hazelcast-clients',
      },
      {label: 'Architecture', to: '/hazelcast/latest/architecture/architecture'},
      {label: 'Deploying with Kubernetes', to: '/hazelcast/latest/kubernetes/deploying-in-kubernetes'},
      {label: 'Best practices', to: '/hazelcast/latest/cluster-performance/best-practices'},
    ],
  },
  {
    title: 'Operate and manage',
    links: [
      {label: 'Configuration', to: '/hazelcast/latest/configuration/understanding-configuration'},
      {label: 'Security', to: '/hazelcast/latest/security/overview'},
      {label: 'CP Subsystem', to: '/hazelcast/latest/cp-subsystem/cp-subsystem'},
      {label: 'WAN Replication', to: '/hazelcast/latest/wan/wan'},
    ],
  },
  {
    title: 'Clients and APIs',
    links: [
      {label: 'Java', to: '/hazelcast/latest/clients/java'},
      {label: 'C++', to: '/hazelcast/latest/clients/cplusplus'},
      {label: 'Python', to: '/hazelcast/latest/clients/python'},
      {label: 'All libraries & APIs (C#, Go...)', to: '/hazelcast/latest/clients/hazelcast-clients'},
    ],
  },
  {
    title: 'Connectors',
    links: [
      {label: 'Kafka', to: '/hazelcast/latest/integrate/kafka-connector'},
      {label: 'MongoDB', to: '/hazelcast/latest/integrate/mongodb-connector'},
      {label: 'JDBC', to: '/hazelcast/latest/integrate/jdbc-connector'},
      {label: 'All connectors (Redis, Custom)', to: '/hazelcast/latest/integrate/connectors'},
    ],
  },
  {
    title: 'Tools',
    links: [
      {label: 'Management Center', to: '/management-center/latest/getting-started/overview'},
      // The component root resolves to the version root, a real page (its index carries `slug: /`).
      {label: 'Platform Operator', to: '/operator/latest/'},
      {label: 'Command Line Client (CLC)', to: '/clc/latest/overview'},
      {label: 'Plugins', to: '/hazelcast/latest/plugins/hazelcast-plugins'},
    ],
  },
  {
    title: 'Hazelcast Cloud',
    links: [
      {label: 'About Hazelcast Cloud', to: '/cloud/overview'},
      {label: 'Hello World', to: '/cloud/get-started'},
      {label: 'Cloud Tutorials', to: '/cloud/tutorials'},
      {label: 'Developer Guide', to: '/cloud/developer-guide'},
    ],
  },
];

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const latest = (siteConfig.customFields?.latestSegs ?? {}) as LatestSegs;

  return (
    <Layout
      description="Find user guides, code samples, tutorials, API reference, and more."
      wrapperClassName={styles.wrapper}>
      {/* The hero and promo bar sit outside `.page` so both span the viewport; breaking out of the centred
          column would need a 100vw trick that overflows when a scrollbar is present. */}
      <header className={styles.hero}>
        <h1>Hazelcast Documentation</h1>
        <p>Find user guides, code samples, tutorials, API reference, and more.</p>
      </header>
      <PromoBanner />
      <main className={styles.page}>
        <div className={styles.grid}>
          {CARDS.map((card) => (
            // Rendered here rather than through HIVE's `title` prop: its three-class rule
            // (`.bordered .heading .title`) can't be outranked from a CSS module without !important.
            <Card
              key={card.title}
              variant="bordered"
              className={styles.card}
              headingContent={<h4 className={styles.cardTitle}>{card.title}</h4>}>
              <ul className={styles.links}>
                {card.links.map((link) => (
                  <li key={link.to}>
                    <Link to={resolveLatest(link.to, latest) ?? link.to}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </main>
    </Layout>
  );
}
