import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {redirects} from './src/redirects';
import {docs, versionedDocs, versionedInstances, latestSegs, isSnapshotUrl} from './src/docsPlugins';
import {variables, versionedVariables} from './src/variables';

// Retired versions served as static Antora HTML from a separate site. See plugins/archived-versions.
const archivedVersions: {origin: string; versions: Record<string, string[]>} = require('./src/archivedVersions.json');

// Links from a product's version dropdown to its newest archived version, whose own picker lists the rest.
// `pathname://` keeps the link out of the router and the broken-link check, because the page is not in this build.
const archivedVersionsItem = (product: string) => [
  {href: `pathname:///${product}/${archivedVersions.versions[product][0]}/`, label: 'Archived versions', target: '_self'},
];

const config: Config = {
  title: 'Hazelcast Documentation',
  tagline: 'Hazelcast product documentation',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  // The origin baked into every canonical tag and sitemap entry.
  url: 'https://docs.hazelcast.com',
  baseUrl: '/',

  // Netlify canonicalizes slashes from the file layout, so this reproduces
  // Antora's URL shape (`/cloud/overview` canonical, the slashed form 301s to
  // it) with no explicit redirects.
  trailingSlash: false,

  headTags: [
    {
      tagName: 'meta',
      // temp Algolia validation tag
      attributes: {name: 'algolia-site-verification', content: '4C927B5F6BF53C1B'},
    },
  ],

  // '.api-specs' is staged by plugins/openapi-specs; listing it here serves it like `static`.
  staticDirectories: ['static', '.api-specs'],

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'ignore',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
      onBrokenMarkdownImages: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: false,
        blog: false,
        // The container also loads the Enzuzo cookie banner, so there is deliberately
        // no Enzuzo script in this repo. Runs only when NODE_ENV=production.
        googleTagManager: {
          containerId: 'GTM-MQ59XD6',
        },
        // Snapshot pages canonical to the latest release, so keep them out of the sitemap.
        sitemap: {
          createSitemapItems: async ({defaultCreateSitemapItems, ...params}) => {
            const items = await defaultCreateSitemapItems(params);
            return items.filter((item) => !isSnapshotUrl(item.url));
          },
        },
        theme: {
          customCss: [
            require.resolve('@hazelcast/ui/styles/variables.css'),
            require.resolve('@hazelcast/ui/styles/typography/open-sans.css'),
            require.resolve('@hazelcast/ui/styles/typography/pp-telegraf.css'),
            './src/css/custom.css',
          ],
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    'docusaurus-plugin-sass',

    // Substitutes {attribute} placeholders in example files per version.
    ['./plugins/example-attributes', {variables, versionedVariables}],

    versionedDocs('hazelcast'), // navbar label "Platform"
    docs('cloud'),
    docs('tutorials'),
    versionedDocs('operator'),
    versionedDocs('clc'),
    versionedDocs('management-center'),
    [
      '@docusaurus/plugin-client-redirects',
      {redirects},
    ],
    // Emits /api/cloud.json for the Cloud console.
    './plugins/cloud-console-index',
    ['./plugins/openapi-specs', {variables, versionedVariables, docs: versionedInstances}],
    './plugins/tutorial-examples',
    './plugins/tutorials-index',
    './plugins/llms-txt',
    ['./plugins/archived-versions', archivedVersions],
  ],

  // Lets the landing page resolve its `/<comp>/latest/` links (no remark pass runs on React pages).
  customFields: {latestSegs},

  clientModules: [
    require.resolve('./src/clientModules/kapa.ts'),
    require.resolve('./src/clientModules/pushfeedback.ts'),
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },

    metadata: [
      {
        name: 'google-site-verification',
        content: '3gaMIo4Cp94mol0v1ae9PNYw9xYLbP4O_IrQxSvnS7E',
      },
    ],

    // The crawler indexes only the latest release of each product, so bump its URL
    // patterns when a version is cut. `contextualSearch` must stay off: it would
    // return no results on older versions.
    algolia: {
      appId: 'QK2EAH8GB0',
      apiKey: '148f165428808580b7a2d0e96f53b707',
      indexName: 'mir-test-new-docs-test',
      contextualSearch: false,
      // No `/search` route; this also drops the modal's "See all results" footer.
      searchPagePath: false,
    },
    navbar: {
      title: '',
      logo: {
        alt: 'Hazelcast',
        src: 'img/hazelcast-logo-original.svg',
        srcDark: 'img/hazelcast-logo-white.svg',
      },
      items: [
        {
          type: 'docSidebar',
          docsPluginId: 'hazelcast',
          sidebarId: 'defaultSidebar',
          position: 'left',
          label: 'Platform',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'management-center',
          sidebarId: 'defaultSidebar',
          position: 'left',
          label: 'Management Center',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'operator',
          sidebarId: 'defaultSidebar',
          position: 'left',
          label: 'Operator',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'cloud',
          sidebarId: 'defaultSidebar',
          position: 'left',
          label: 'Cloud',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'clc',
          sidebarId: 'defaultSidebar',
          position: 'left',
          label: 'CLC',
        },
        // Plain link: tutorials has no sidebar.
        {
          to: '/tutorials',
          position: 'left',
          label: 'Tutorials',
        },
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'hazelcast',
          position: 'right',
          dropdownItemsAfter: archivedVersionsItem('hazelcast'),
        },
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'operator',
          position: 'right',
          dropdownItemsAfter: archivedVersionsItem('operator'),
        },
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'clc',
          position: 'right',
          dropdownItemsAfter: archivedVersionsItem('clc'),
        },
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'management-center',
          position: 'right',
          dropdownItemsAfter: archivedVersionsItem('management-center'),
        },
        // Declared explicitly so search sits before Ask AI and the CTA.
        {type: 'search', position: 'right'},
        {type: 'custom-ask-ai', position: 'right'},
        {type: 'custom-cta', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          items: [
            {
              label: 'Hazelcast.com',
              href: 'https://hazelcast.com/?utm_source=docs-website',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/hazelcast/hazelcast'
            },
            {
              label: 'Terms of Service',
              href: 'https://hazelcast.com/terms-of-use/?utm_source=docs-website',
            },
            {
              label: 'Privacy',
              to: '/privacy',
            },
            {
              label: 'Contact us',
              href: 'https://hazelcast.com/contact/?utm_source=docs-website',
            },
            {
              label: 'Support',
              href: 'https://support.hazelcast.com/s/?utm_source=docs-website',
            },
          ],
        },
      ],
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      // A language missing here renders unhighlighted, silently.
      additionalLanguages: [
        'bash', 'java', 'properties', 'csharp',
        'batch', 'cmake', 'docker', 'dot', 'groovy', 'php', 'protobuf',
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
