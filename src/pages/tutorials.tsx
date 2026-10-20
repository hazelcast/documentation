import {useMemo, useState, type ReactNode} from 'react';
import Layout from '@theme/Layout';
import {Search} from 'react-feather';
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
const PRODUCT_LABELS: Record<string, string> = {
  cloud: 'Cloud',
  platform: 'Platform',
  operator: 'Operator',
  imdg: 'IMDG',
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

  const [query, setQuery] = useState('');
  const [product, setProduct] = useState(ALL);
  const [language, setLanguage] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [includeEnterprise, setIncludeEnterprise] = useState(true);

  const products = useMemo(
    () => uniqueSorted(cards.flatMap(productsOf)),
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

        <p className={styles.count}>
          {shown.length} of {cards.length} tutorials
        </p>

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
