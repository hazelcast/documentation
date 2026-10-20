import {useEffect, useMemo, useState, type ReactNode} from 'react';
import Layout from '@theme/Layout';
import {Search} from 'react-feather';
import {useHistory, useLocation} from '@docusaurus/router';
import {usePluginData} from '@docusaurus/useGlobalData';
import {Badge} from '@hazelcast/ui/lib/components/Badge';
import {Button} from '@hazelcast/ui/lib/components/Button';
import {ButtonGroup} from '@hazelcast/ui/lib/components/ButtonGroup';
import {Card} from '@hazelcast/ui/lib/components/Card';
import {EmptyState} from '@hazelcast/ui/lib/components/EmptyState';
import {AutocompleteField} from '@hazelcast/ui/lib/components/AutocompleteField';
import {TextField} from '@hazelcast/ui/lib/components/TextField';
import {Toggle} from '@hazelcast/ui/lib/components/Toggle';
import styles from './tutorials.module.css';

// Tutorials landing page. Card data comes from `tutorial_*` frontmatter, collected by plugins/tutorials-index.
// Facet values are whatever the guides declare, deliberately unnormalised.

type Card = {
  title: string;
  description: string;
  href: string;
  time: string;
  product: string;
  languages: string[];
  categories: string[];
  enterprise: boolean;
  source: string;
};

const ALL = 'all';

// Facet labels for the values the guides actually use. A value with no entry
// here falls back to itself, so a new tag shows up rather than disappearing.
// Key order is the product filter's button order; unlisted values follow, alphabetically.
const PRODUCT_LABELS: Record<string, string> = {
  platform: 'Platform',
  operator: 'Operator',
  cloud: 'Cloud',
  imdg: 'IMDG',
};
const PRODUCT_ORDER = Object.keys(PRODUCT_LABELS);
const productRank = (p: string) => {
  const i = PRODUCT_ORDER.indexOf(p);
  return i < 0 ? PRODUCT_ORDER.length : i;
};

const LANG_LABELS: Record<string, string> = {
  java: 'Java',
  python: 'Python',
  python3: 'Python',
  node: 'Node.js',
  go: 'Go',
  sql: 'SQL',
  cplus: 'C++',
  csharp: 'C#',
};

const label = (map: Record<string, string>, v: string) => map[v.toLowerCase()] ?? v;

// A card's product cell can list more than one ("platform, cloud").
const productsOf = (c: Card) =>
  c.product.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, {sensitivity: 'base'}),
  );
}

export default function Tutorials(): ReactNode {
  const data = usePluginData('tutorials-index') as {cards?: Card[]} | undefined;
  const cards = data?.cards ?? [];

  // The filters live in the query string so a filtered view can be linked to.
  const history = useHistory();
  const {search} = useLocation();
  const initial = new URLSearchParams(search);
  const [query, setQuery] = useState(initial.get('q') ?? '');
  const [product, setProduct] = useState(initial.get('product') ?? ALL);
  const [language, setLanguage] = useState(initial.get('language') ?? ALL);
  const [category, setCategory] = useState(initial.get('category') ?? ALL);
  const [includeEnterprise, setIncludeEnterprise] = useState(initial.get('enterprise') !== '0');

  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (product !== ALL) params.set('product', product);
    if (language !== ALL) params.set('language', language);
    if (category !== ALL) params.set('category', category);
    if (!includeEnterprise) params.set('enterprise', '0');
    const next = params.toString();
    if (next !== search.replace(/^\?/, '')) history.replace({search: next ? `?${next}` : ''});
  }, [query, product, language, category, includeEnterprise]);

  const filtered =
    query !== '' || product !== ALL || language !== ALL || category !== ALL || !includeEnterprise;
  const clearFilters = () => {
    setQuery('');
    setProduct(ALL);
    setLanguage(ALL);
    setCategory(ALL);
    setIncludeEnterprise(true);
  };

  const products = useMemo(
    () => uniqueSorted(cards.flatMap(productsOf)).sort((a, b) => productRank(a) - productRank(b)),
    [cards],
  );
  const languages = useMemo(
    () => uniqueSorted(cards.flatMap((c) => c.languages.map((l) => l.toLowerCase()))),
    [cards],
  );
  const categories = useMemo(
    () => uniqueSorted(cards.flatMap((c) => c.categories)),
    [cards],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (!includeEnterprise && c.enterprise) return false;
      if (product !== ALL && !productsOf(c).includes(product)) return false;
      if (language !== ALL && !c.languages.some((l) => l.toLowerCase() === language)) return false;
      if (category !== ALL && !c.categories.includes(category)) return false;
      if (q && !(c.title + ' ' + c.description).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [cards, query, product, language, category, includeEnterprise]);

  return (
    <Layout
      title="Tutorials and Recipes"
      description="Learn how to build and run applications with Hazelcast.">
      <main className={styles.page}>
        <div className={styles.intro}>
          <h1>Tutorials and Recipes</h1>
          <p>
            Learn how to build and run applications with Hazelcast. Whether you want a
            simple getting started or an end-to-end example of a use case, use the search
            and filters below to find what you're looking for.
          </p>
        </div>

        <div className={styles.filters}>
          <div className={styles.product}>
            <span className={styles.filterLabel}>Product</span>
            {/* Same control as the search modal's product filter (src/theme/SearchBar). */}
            <ButtonGroup ariaLabel="Filter tutorials by product">
              {[ALL, ...products].map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={product === p ? 'contained' : 'outlined'}
                  {...({'aria-pressed': product === p} as React.AriaAttributes)}
                  onClick={() => setProduct(p)}>
                  {p === ALL ? 'All' : label(PRODUCT_LABELS, p)}
                </Button>
              ))}
            </ButtonGroup>
          </div>
          <div className={styles.fields}>
            <TextField
              name="tutorial-search"
              label="Search"
              placeholder="Search tutorials"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <AutocompleteField
              name="tutorial-language"
              label="Language"
              value={language}
              onChange={(v) => setLanguage(v ?? ALL)}
              options={[
                {value: ALL, label: 'All languages'},
                ...languages.map((l) => ({value: l, label: label(LANG_LABELS, l)})),
              ]}
            />
            <AutocompleteField
              name="tutorial-category"
              label="Category"
              value={category}
              onChange={(v) => setCategory(v ?? ALL)}
              options={[
                {value: ALL, label: 'All categories'},
                ...categories.map((c) => ({value: c, label: c})),
              ]}
            />
          </div>
          <div className={styles.edition}>
            <Toggle
              name="include-enterprise"
              label="Include Enterprise"
              checked={includeEnterprise}
              onChange={(e) => setIncludeEnterprise(e.target.checked)}
            />
          </div>
        </div>

        <div className={styles.countRow}>
          <p className={styles.count}>
            {shown.length} of {cards.length} tutorials
          </p>
          {filtered && (
            <Button type="button" variant="link" onClick={clearFilters}>
              Clear all filters
            </Button>
          )}
        </div>

        {shown.length === 0 ? (
          <EmptyState
            icon={Search}
            iconLabel=""
            title="No tutorials match those filters"
            description="Try clearing a filter or searching for something broader."
          />
        ) : (
          <div className={styles.grid}>
            {shown.map((c) => (
              <Card key={c.href} variant="bordered" className={styles.card}>
                <div className={styles.meta}>
                  {[label(PRODUCT_LABELS, productsOf(c)[0] ?? ''), c.time]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <h3>{c.title}</h3>
                <div className={styles.chips}>
                  {c.enterprise && <Badge type="warning" content="Enterprise" />}
                  {c.categories.map((cat) => (
                    <Badge key={cat} type="neutral" content={cat} />
                  ))}
                  {c.languages.map((l) => (
                    <Badge key={l} type="neutral" content={label(LANG_LABELS, l)} />
                  ))}
                </div>
                <p className={styles.blurb}>{c.description}</p>
                <div className={styles.actions}>
                  <Button component="a" href={c.href} variant="contained" color="primary">
                    Start
                  </Button>
                  {c.source && (
                    <Button
                      component="a"
                      href={c.source}
                      target="_blank"
                      rel="noopener"
                      variant="outlined">
                      View source
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>
    </Layout>
  );
}
