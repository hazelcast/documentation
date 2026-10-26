import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {redirects} from './src/redirects';
import {docs, versionedDocs, versionedInstances, latestSegs, canonicalSitemapItems} from './src/docsPlugins';
import {variables, versionedVariables} from './src/variables';

// Retired versions served as static Antora HTML from a separate site. See plugins/archived-versions.
const archivedVersions: {origin: string; versions: Record<string, string[]>} = require('./src/archivedVersions.json');

// Links from a product's version dropdown to its newest archived version, whose own picker lists the rest.
// `pathname://` keeps the link out of the router and the broken-link check, because the page is not in this build.
const archivedVersionsItem = (product: string) => [
  {href: `pathname:///${product}/${archivedVersions.versions[product][0]}/`, label: 'Archives', target: '_self', className: 'archived-versions-link'},
];

// Product tabs, also listed in a "Products" dropdown that replaces them at narrow desktop widths (see custom.css).
const products = [
  {docsPluginId: 'hazelcast', label: 'Platform'},
  {docsPluginId: 'management-center', label: 'Management Center'},
  {docsPluginId: 'operator', label: 'Operator'},
  {docsPluginId: 'cloud', label: 'Cloud'},
  {docsPluginId: 'clc', label: 'CLC'},
].map((product) => ({type: 'docSidebar', sidebarId: 'defaultSidebar', ...product}));

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
        // The sitemap lists canonical URLs only, to agree with the cross-version canonicals.
        sitemap: {
          createSitemapItems: async ({defaultCreateSitemapItems, ...params}) =>
            canonicalSitemapItems(await defaultCreateSitemapItems(params)),
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
    // rspack's realContentHash string-replaces hashes in the SSG bundle, page text included.
    () => ({
      name: 'server-real-content-hash-off',
      configureWebpack: (_config: unknown, isServer: boolean) =>
        isServer ? {optimization: {realContentHash: false}} : {},
    }),
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
      apiKey: '360d69c2e5f2f150cbf4322abb413956',
      indexName: 'new-docs',
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
          type: 'dropdown',
          label: 'Products',
          position: 'left',
          className: 'navbar-products-dropdown',
          items: products,
        },
        ...products.map((product) => ({...product, position: 'left' as const, className: 'navbar-product-tab'})),
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
      style: 'light',
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
      // The GitHub and Dracula token colours on HIVE backgrounds: `--hive-color-surface-hover-v4` in light, the raised surface `--hive-color-neutral-white-v4` in dark.
      // Literals, not `var()`: the API reference passes these colours to Redoc, whose darken/transparentize cannot parse `var()`.
      theme: {
        ...prismThemes.github,
        plain: {...prismThemes.github.plain, backgroundColor: '#f5f5f5'},
      },
      darkTheme: {
        ...prismThemes.dracula,
        plain: {...prismThemes.dracula.plain, backgroundColor: '#2a2d3a'},
      },
      // A language missing here renders unhighlighted, silently.
      additionalLanguages: [
        'bash', 'java', 'properties', 'csharp',
        'batch', 'cmake', 'docker', 'dot', 'groovy', 'php', 'protobuf',
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
