// The title one menu item renders under — in its heading, and in the page's
// table of contents, which must agree.
//
// Redoc names an operation with this precedence (`getOperationSummary`):
//
//   summary || operationId || description.substring(0, 50) || pathName || '<no summary>'
//
// The first two are what a spec author intends, and cover 56 of the 69
// operations the Management Center specs publish. The description fallback is
// not: it is a HARD CUT at 50 characters, mid-word, and the description then
// renders again — in full — directly beneath the heading it was cut down for.
// The WAN Replication spec gives all 13 of its operations a `description` and no
// `summary`, so every heading on that page was truncated prose over a copy of
// itself:
//
//   get all WAN replication configs for the given clus
//   GET /rest/clusters/{cluster}/wan/replications
//   get all WAN replication configs for the given cluster
//
// Those descriptions ARE summaries — "add new WAN replication" is a title, not a
// paragraph — so the fix is to use the whole one and drop the duplicate, rather
// than to fall back to something else. Sentence-cased, since a description is
// written as prose and starts lowercase.
//
// The specs themselves are not touched: they live in a product repo, they are
// fetched per version at build time (see plugins/openapi-specs), and a
// `summary` added upstream simply takes over from this — see below.

type Item = {
  type?: string;
  name: string;
  description?: string;
  httpVerb?: string;
  path?: string;
};

// Redoc's cut-off, reproduced only to RECOGNISE the fallback it produced.
const REDOC_DESCRIPTION_CUTOFF = 50;

// How much prose still reads as a heading. Every description in the corpus is
// well inside this (the longest is 69 characters); one longer, or one spanning
// paragraphs, is body text — it stays in the body, and the endpoint becomes the
// heading instead.
const MAX_PROSE_TITLE = 80;

// Capitalise a title lifted from a description. Left alone when the first word
// is an identifier rather than a word — `mapName`, `getFoo`, `x-hazelcast-…` —
// where an initial capital would make it a different name.
function sentenceCase(text: string): string {
  const [firstWord = ''] = text.split(/\s/, 1);
  if (/[A-Z]/.test(firstWord.slice(1)) || /[^\p{L}'-]/u.test(firstWord)) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// `usesDescription` tells the caller the description has been spent on the
// heading and must not be rendered under it as well.
export function titleFor(item: Item): {title: string; usesDescription: boolean} {
  const asIs = {title: item.name, usesDescription: false};
  if (item.type !== 'operation') {
    return asIs;
  }
  const endpoint =
    item.httpVerb && item.path ? `${item.httpVerb.toUpperCase()} ${item.path}` : item.name;

  // Redoc fell back to the description: `name` IS the description, cut at 50.
  // Recognised by its outcome because OperationModel does not expose `summary`,
  // so the precedence cannot be re-run from the model — only its result read.
  // Which is also why nothing here has to be revisited when a spec gains real
  // summaries upstream: `name` stops matching, and the summary is used.
  if (item.description && item.name === item.description.substring(0, REDOC_DESCRIPTION_CUTOFF)) {
    const prose = item.description.trim();
    return /\n/.test(prose) || prose.length > MAX_PROSE_TITLE
      ? {title: endpoint, usesDescription: false}
      : {title: sentenceCase(prose), usesDescription: true};
  }
  // No summary, no operationId, no description: Redoc's last resort is the bare
  // path, which does not say WHICH of that path's operations this is.
  if (item.name === item.path) {
    return {title: endpoint, usesDescription: false};
  }
  return asIs;
}
