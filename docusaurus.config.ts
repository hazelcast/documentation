import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {redirects} from './src/redirects';
// The docs plugin instances. One shared factory per kind (unversioned /
// versioned) holds everything the components have in common, and derives each
// versioned component's version set from its <id>_versions.json.
import {docs, versionedDocs, latestSegs, isSnapshotUrl} from './src/docsPlugins';
// The single source of doc variables, also handed to the example-attributes
// build loader so co-located example files resolve their {attribute}
// placeholders per version at build (one file, no generated twin).
import {variables, versionedVariables} from './src/variables';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// Management Center's docs instance, declared once because two plugins need it:
// the docs instance itself, and openapi-specs, which has to know the URL segment
// the current version is served at to stage that version's API specs there.
const managementCenter = {
  id: 'management-center',
  currentSeg: '5.12-snapshot',
  currentLabel: '5.12-SNAPSHOT',
  defaultVersion: 'latest-release',
} as const;

// Platform's, declared here for the same reason: it is the second component with
// an API-reference page (maintain-cluster/rest-api-swagger), so openapi-specs
// needs its current version's URL segment too.
const platform = {
  id: 'hazelcast',
  currentSeg: '6.0-snapshot',
  currentLabel: '6.0-SNAPSHOT',
  defaultVersion: 'latest-release',
} as const;

const config: Config = {
  title: 'Hazelcast Documentation',
  tagline: 'Hazelcast product documentation',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // The production url. Matches the Antora playbook's `site.url`, and is not
  // cosmetic: it is the origin baked into every canonical tag and every
  // sitemap entry, so a placeholder here ships a sitemap pointing at a domain
  // that does not exist.
  url: 'https://docs.hazelcast.com',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // Emit `page.html`, not `page/index.html`, so a page's URL carries no
  // trailing slash. This reproduces the Antora site's URL shape on the host
  // that serves it (Netlify behind Cloudflare), measured against production
  // rather than inferred.
  //
  // Netlify has no site-wide slash convention: it derives the canonical form
  // per path from the file layout, and 301s the other form to it in BOTH
  // directions. Under Antora's `html_extension_style: drop` a page is a file,
  // so `/cloud/overview` is canonical and `/cloud/overview/` 301s to it. That
  // is what `false` reproduces, for ~3,355 of ~3,375 URLs byte-for-byte, and
  // it is the form the sitemap and canonical tags already advertise -- leaving
  // this unset made every canonical URL a redirect.
  //
  // `false` does create 27 places where a file sits next to a directory of the
  // same name (`hazelcast/5.7.html` beside `hazelcast/5.7/`), which is the one
  // shape worth checking before trusting a host. Production already contains
  // it -- `/management-center/5.10/getting-started` is a file with a directory
  // of children beside it -- and Netlify resolves it correctly: the file wins
  // for the bare path, the slash form 301s to it, the children are unaffected.
  // So no explicit trailing-slash redirects are needed for those 27 roots.
  //
  // The ~27 root URLs whose canonical form flips from slashed to unslashed
  // (component roots, version roots, the Management Center module roots,
  // `/privacy`) keep working via that automatic 301. Purge the Cloudflare
  // cache at cutover: it is holding 200s for them.
  trailingSlash: false,

  // '.api-specs' is where plugins/openapi-specs stages the OpenAPI specs it
  // fetches from the product repos: gitignored, rebuilt every run, and listed
  // here so Docusaurus copies it on `build` and serves it on `start` exactly as
  // it does `static`. That is what republishes each spec at the attachment URL
  // the Antora site uses, which Redoc's "Download OpenAPI specification" button
  // links to.
  staticDirectories: ['static', '.api-specs'],

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'facebook', // Usually your GitHub org/user name.
  projectName: 'docusaurus', // Usually your repo name.

  // Migration in progress: links to not-yet-converted components (and the few
  // links broken in production) must not fail the build. Flip back to 'throw'
  // once every component is migrated.
  onBrokenLinks: 'warn',
  onBrokenAnchors: 'ignore',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
      // Images are co-located with the pages that use them and referenced by a
      // relative path, so webpack resolves and fingerprints each one. A missing
      // image is a real error (a page migrated without its assets), so fail the
      // build on it -- that build-time guarantee is why we co-locate rather than
      // dump into static/. migration/extract-images.js places the images.
      onBrokenMarkdownImages: 'throw',
    },
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        // The default docs preset instance and blog are disabled: every
        // migrated component is its own plugin-content-docs instance (see the
        // `cloud` plugin below), and the site has no blog.
        docs: false,
        blog: false,
        // Google Tag Manager container GTM-MQ59XD6, the same one the Antora site
        // loads. The container is the ONLY thing this repo declares about
        // analytics or consent, deliberately: the Enzuzo cookie banner is a tag
        // inside it (the "Enzuzo Cookie Manager" template, on the Consent
        // Initialization trigger), which is both Enzuzo's documented install and
        // what production already runs.
        //
        // The Antora theme ALSO hardcodes the Enzuzo bundle in <head>, so every
        // production page loads the banner twice and the bundle says so:
        // "[enzuzo] more than one cookie banner was attempted to be loaded".
        // That second copy is `defer`red and sits after the GTM snippet, so it
        // could never set Consent Mode defaults in time and is pure liability --
        // Enzuzo's own guidance is to deploy via GTM and NOT hardcode, because
        // hardcoding creates conflicting sources of truth. Not reproducing it is
        // the fix; there is deliberately no Enzuzo <script> anywhere in this repo.
        //
        // Consequences worth knowing. The plugin is a NO-OP unless
        // NODE_ENV=production, so neither GTM nor the banner appears under
        // `docusaurus start` -- use `build` + `serve` to see either. And a reader
        // blocking googletagmanager.com gets no banner and an inert
        // `#manage_cookies` link on /privacy; accepted, since that reader is
        // blocking every tag the banner exists to gate.
        googleTagManager: {
          containerId: 'GTM-MQ59XD6',
        },
        // Snapshot versions are dropped from the sitemap. Their pages already
        // canonical to the latest release, so listing them would ask Google to
        // index pages we have just told it to treat as duplicates of another
        // URL. This changes nothing else: snapshot docs stay built, linked,
        // navigable and reachable — a sitemap is a crawl invitation, not an
        // access control. Which segments count is derived from the version
        // config, so a release or an archived version needs no edit here.
        sitemap: {
          createSitemapItems: async ({defaultCreateSitemapItems, ...params}) => {
            const items = await defaultCreateSitemapItems(params);
            return items.filter((item) => !isSnapshotUrl(item.url));
          },
        },
        theme: {
          // HIVE v4 design tokens (:root CSS custom props) + brand fonts, both
          // shipped by @hazelcast/ui. v4 components read var(--hive-*) and the
          // @font-face families from here, or render unstyled/with fallback type.
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
    // Compiles HIVE's shipped .module.scss (Button.module.scss, constants,
    // helpers) so swizzled components can import them.
    'docusaurus-plugin-sass',

    // Registers the example-attributes loader so co-located example files keep
    // their Antora {attribute} placeholders (byte-faithful, single-sourced) and
    // have them substituted per-version at build. Fed from src/variables.ts.
    ['./plugins/example-attributes', {variables, versionedVariables}],

    // Platform docs — migration target #5 and the biggest by a wide margin: 439
    // pages over 46 Antora modules. The plugin id is the Antora component name
    // `hazelcast`, because that is the URL segment production serves it at
    // (/hazelcast/6.0-snapshot/sql/…); the navbar calls it "Platform", which is
    // the product's name. Its main is a NUMBERED snapshot like MC's — published
    // under `6.0-snapshot`, displayed `6.0-SNAPSHOT`.
    //
    // The live release set lives in lib/layout.js VERSIONS.hazelcast, so it needs
    // no edit here — and because main is an unreleased snapshot, the dropdown
    // lands on the newest release, as production does. Currently 5.7/5.6/5.5;
    // 5.4 and 5.3 are still to come (they nav differently — see that file).
    versionedDocs(platform),
    // Cloud docs — migration target #1. Unversioned: the only version is served
    // at the base path with no version segment, and routeBasePath === the Antora
    // component name, so URLs match production exactly (/cloud/<page>).
    docs('cloud'),
    // Tutorials — migration target #6. Unversioned, and the first NAV-LESS
    // component: its 57 pages are one flat set reached from the /tutorials index,
    // never a sidebar (Antora serves them through a TOC-only layout with no nav
    // tree), so nothing here declares a sidebar and the pages carry no
    // sidebar_position. The component is assembled from 56 hazelcast-guides
    // repos plus one bespoke page in cloud-docs; only the prose is migrated,
    // the runnable code stays in the guide repos.
    docs('tutorials'),
    // Operator docs — migration target #2 and the VERSIONED warm-up before
    // Platform (same `main + v/*` Antora branch model). Antora serves main at
    // `/operator/latest-snapshot/` and the dropdown lands on the newest release;
    // releases older than the live set are frozen as static HTML outside this
    // build. The live set itself is operator_versions.json, generated by the
    // converter — adding a release there is the whole change.
    versionedDocs({id: 'operator', currentSeg: 'latest-snapshot', defaultVersion: 'latest-release'}),
    // CLC docs — migration target #3 and the SECOND versioned instance. Unlike
    // operator, clc's `main` declares itself the released version rather than a
    // `-snapshot` line, so it has no `latest-snapshot` render: the current version
    // is served under its own numeric seg and is what the dropdown lands on. Only
    // the previous release (5.5.0) is cut as a versioned copy, matching the two
    // versions clc serves in production.
    versionedDocs({id: 'clc', currentSeg: '5.5.1', defaultVersion: 'current'}),
    // Management Center docs — migration target #4, and the first MULTI-MODULE
    // component: its 102 pages live in 11 Antora modules, whose names are URL
    // segments (/management-center/5.11/clusters/dashboard), so a page is
    // identified by module + stem rather than stem alone. Its main is a NUMBERED
    // snapshot — published under `5.12-snapshot`, displayed as `5.12-SNAPSHOT` —
    // and the dropdown lands on the newest release (5.11), as production does.
    versionedDocs(managementCenter),
    // Reproduces Antora's page-aliases as static meta-refresh redirect stubs at
    // the old URLs, so existing bookmarks/inbound links still land on the moved
    // page. Pairs are generated from the manifest into src/redirects.ts by the
    // converter; matches production's default ('static') Antora redirect facility.
    [
      '@docusaurus/plugin-client-redirects',
      {
        // The generated table plus one entry that is not the migration's to
        // generate. Antora served the landing page at `/home/` and bounced `/`
        // to it (playbook `site.start_page: home::index.adoc`); here the page IS
        // `/` (src/pages/index.tsx), so the bounce reverses. It lives out here
        // rather than in src/redirects.ts because that file is regenerated whole
        // from the manifest on every converter run, and this pair comes from
        // neither a page-alias nor an orphan decision -- it is the site's own
        // shape, and has to outlive the migration tooling.
        redirects: [...redirects, {from: '/home', to: '/'}],
      },
    ],
    // Emits /api/cloud.json at build time from the cloud docs' cloud_* frontmatter
    // — the console index the Hazelcast Cloud console fetches. Permanent
    // replacement for the Antora api-json.js extension; see plugins/cloud-console-index.
    './plugins/cloud-console-index',
    // Stages the OpenAPI specs the <ApiReference/> pages render, fetching each
    // from the product repo that owns it at the branch that version's
    // {…-swagger-branch} attribute names. See plugins/openapi-specs.
    ['./plugins/openapi-specs', {variables, versionedVariables, docs: [managementCenter, platform]}],
    // Stages the example files the tutorial pages import. Their source of truth is
    // the guide repo that owns each one — nothing is copied into this repo, only
    // referenced from tutorials/examples.json at a pinned commit. See that plugin.
    './plugins/tutorial-examples',
    // Collects the `tutorial_*` card frontmatter the converter writes onto each
    // tutorial and hands it to src/pages/tutorials.tsx as global data — the
    // replacement for Antora's landing page, which read the content catalog.
    './plugins/tutorials-index',
    // Emits /llms.txt — the index an LLM or coding agent reads to find its way
    // around the docs. Covers the current release of each component only (the
    // version Docusaurus marks `isLast`, so snapshots are excluded exactly as
    // they are from the sitemap). Written in postBuild from the docs plugins'
    // own loaded content; see plugins/llms-txt for why that hook, and for where
    // the later llms-full.txt / per-page .md pass will attach.
    './plugins/llms-txt',
  ],

  // Handed to the client bundle for the landing page's card links, which are
  // written as `/<comp>/latest/...` and resolved at render by resolveLatest
  // (src/remark/latestLinks.ts). A React page gets no remark pass, so without
  // this the twenty `/latest/` hrefs on `/` would each be reported broken --
  // <Link> collects its href for the checker, and the alias is host
  // infrastructure rather than a route. Same contract as the MDX side: a version
  // cut re-points every one of them with no content change.
  customFields: {latestSegs},

  // Loads the Kapa AI widget and keeps its cookie in step with Enzuzo's consent
  // state. Not prod-gated like the GTM container: the widget is a feature of the
  // site, so it runs on the dev server too.
  clientModules: [require.resolve('./src/clientModules/kapa.ts')],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },

    // Search Console ownership
    metadata: [
      {
        name: 'google-site-verification',
        content: '3gaMIo4Cp94mol0v1ae9PNYw9xYLbP4O_IrQxSvnS7E',
      },
    ],

    // Search. Points at `prod_hazelcast_docs` -- the index the ANTORA site's
    // scraper still builds (hazelcast-docs/.github/workflows/index-site.yml, from
    // search-config.json), reused as-is for cutover rather than re-crawled first.
    // That works because the migration preserved URLs and heading anchors, and
    // because the scraper already sets `hierarchy.lvl0` to the product name, which
    // is what DocSearch groups results by.
    //
    // Two consequences that a re-crawl will reverse, both handled in the swizzled
    // SearchBar rather than here:
    //   - the only facetable attribute is Antora's `tags`, not `docusaurus_tag`,
    //     so `contextualSearch` MUST stay off: left on, every query would filter
    //     on a facet the index does not have and return nothing.
    //   - the index holds every published version, so the product filter names the
    //     latest release of each component explicitly to keep old versions out.
    //
    // AT CUTOVER: disable that scraper workflow. It runs on the 1st and 15th
    // against docs.hazelcast.com with Antora selectors (`.doc h1`, XPath nav
    // lookups for lvl0); once that hostname serves this site those match nothing,
    // and the next scheduled run replaces a working index with empty records.
    algolia: {
      appId: 'QK2EAH8GB0',
      apiKey: 'ef7bd9485eafbd75d6e8425949eda1f5',
      indexName: 'prod_hazelcast_docs',
      contextualSearch: false,
      // No `/search` route: Antora serves no search page, so adding one would be a
      // new URL rather than a preserved one. Also suppresses the modal's "See all
      // N results" footer, which would otherwise link somewhere that 404s.
      searchPagePath: false,
    },
    navbar: {
      // No title text: the logo wordmark stands alone.
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
        // Tutorials, last in the row. A plain link rather than a `docSidebar`
        // item: the component is nav-less (its pages are one flat set reached
        // from the index, as Antora serves them), so there is no sidebar to
        // open and a docSidebar item would have nothing to point at.
        {
          to: '/tutorials',
          position: 'left',
          label: 'Tutorials',
        },
        // Version dropdown for the hazelcast (Platform) instance: the
        // 6.0-SNAPSHOT current version plus the live releases.
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'hazelcast',
          position: 'right',
        },
        // Version dropdown for the operator instance (current + live releases).
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'operator',
          position: 'right',
        },
        // Version dropdown for the clc instance (current 5.5.1 + the 5.5.0 copy).
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'clc',
          position: 'right',
        },
        // Version dropdown for the management-center instance (5.12-SNAPSHOT +
        // the 5.11/5.10/5.9 copies).
        {
          type: 'docsVersionDropdown',
          docsPluginId: 'management-center',
          position: 'right',
        },
        // Search, declared EXPLICITLY rather than left to Docusaurus. With no
        // `search` item the theme auto-appends the search bar after every other
        // navbar item, which would put it past the CTA; naming it here fixes its
        // position and lets Ask AI sit next to it, as the Antora header does.
        {type: 'search', position: 'right'},
        // Ask AI, immediately after search. Opens the Kapa modal; the widget
        // itself is loaded by src/clientModules/kapa.ts and its own floating
        // launcher is suppressed, so this button is the only way in.
        // Registered in src/theme/NavbarItem/ComponentTypes.tsx.
        {type: 'custom-ask-ai', position: 'right'},
        // CTA, rendered as a HIVE Button (Try Free on Cloud pages,
        // Try Hazelcast elsewhere). Registered in
        // src/theme/NavbarItem/ComponentTypes.tsx.
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
      // prism-react-renderer bundles ~50 languages; anything else the docs use
      // must be named here or its code blocks render UNHIGHLIGHTED (silently --
      // the fidelity harness compares text and structure, not highlighting).
      // Each entry below is a language some page actually uses, checked against
      // the migrated set by constructcheck's source-language census.
      // `docker` also registers the `dockerfile` alias; `batch` covers `[source,bat]`.
      additionalLanguages: [
        'bash', 'java', 'properties', 'csharp',
        'batch', 'cmake', 'docker', 'dot', 'groovy', 'php', 'protobuf',
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
