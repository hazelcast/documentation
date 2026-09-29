// The title a menu item renders under, in its heading and in the TOC.
// Redoc's fallback when an operation has no summary/operationId is `description.substring(0, 50)`: a mid-word cut, with the full description repeated beneath.
// Descriptions in the specs are title-like, so use the whole one (sentence-cased) and suppress the duplicate. A `summary` added upstream takes over automatically.

type Item = {
  type?: string;
  name: string;
  description?: string;
  httpVerb?: string;
  path?: string;
};

// Redoc's cut-off, reproduced only to recognise its fallback.
const REDOC_DESCRIPTION_CUTOFF = 50;

// Longer or multi-paragraph descriptions are body text, not headings.
const MAX_PROSE_TITLE = 80;

// Left alone when the first word is an identifier (`mapName`, `getFoo`), where a capital would change the name.
function sentenceCase(text: string): string {
  const [firstWord = ''] = text.split(/\s/, 1);
  if (/[A-Z]/.test(firstWord.slice(1)) || /[^\p{L}'-]/u.test(firstWord)) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// `usesDescription`: the description was spent on the heading and must not render beneath it.
export function titleFor(item: Item): {title: string; usesDescription: boolean} {
  const asIs = {title: item.name, usesDescription: false};
  if (item.type !== 'operation') {
    return asIs;
  }
  const endpoint =
    item.httpVerb && item.path ? `${item.httpVerb.toUpperCase()} ${item.path}` : item.name;

  // Redoc fell back to the description: `name` is the description cut at 50. Recognised by outcome, since OperationModel does not expose `summary`.
  if (item.description && item.name === item.description.substring(0, REDOC_DESCRIPTION_CUTOFF)) {
    const prose = item.description.trim();
    return /\n/.test(prose) || prose.length > MAX_PROSE_TITLE
      ? {title: endpoint, usesDescription: false}
      : {title: sentenceCase(prose), usesDescription: true};
  }
  // Redoc's last resort is the bare path, which doesn't say which of its operations this is.
  if (item.name === item.path) {
    return {title: endpoint, usesDescription: false};
  }
  return asIs;
}
