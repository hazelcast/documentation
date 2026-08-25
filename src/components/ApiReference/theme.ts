import type {RedocRawOptions} from 'redoc';

// Redoc's theme is a JavaScript object, not CSS, and it is not merely handed to
// styled-components: Redoc runs polished's darken/transparentize over several of
// these colours INSIDE its components (a `oneOf` type button does
// `darken(0.15, colors.primary.main)`; the payload panels transparentize
// `rightPanel.backgroundColor`). polished cannot parse `var(--x)`, so a CSS
// custom property passed straight through would throw at render time.
//
// So the tokens are not copied here — they are RESOLVED here. Every colour is
// read from the live custom property at render time and normalised to a plain
// colour string polished can take. HIVE (and Infima, which the site already
// derives from HIVE) stays the single source of truth: change a token and these
// pages follow it, with nothing to keep in step. It is also what makes dark mode
// free — Docusaurus redefines the same properties under [data-theme='dark'], so
// re-reading them is the whole of it.
//
// Fonts are exempt: they pass through to CSS untouched, so they stay as `var(…)`
// references and need no resolution.

// Which custom property backs each Redoc colour. Anything that does not resolve
// is left off the theme entirely, so a renamed or missing token degrades to
// Redoc's own default rather than poisoning the theme.
const TOKENS = {
  primary: {main: '--hive-color-primary-v4'},
  text: {primary: '--ifm-font-color-base', secondary: '--ifm-color-emphasis-700'},
  border: {dark: '--ifm-color-emphasis-300', light: '--ifm-color-emphasis-200'},
  schema: {
    nestedBackground: '--ifm-color-emphasis-100',
    linesColor: '--ifm-color-emphasis-300',
  },
  links: {
    color: '--ifm-link-color',
    visited: '--ifm-link-color',
    hover: '--ifm-link-hover-color',
  },
  code: {color: '--ifm-font-color-base', backgroundColor: '--ifm-code-background'},
} as const;

// Canvas is the colour parser the platform already ships, used twice over.
// Assigning to fillStyle VALIDATES any syntax the browser understands — oklch,
// which the HIVE v4 tokens are written in, and color-mix, which the site's
// derived Infima shades use; an unparseable value leaves fillStyle at its
// previous value, which is what the double assignment detects. Painting the
// colour and reading the pixel back then CONVERTS it, which the assignment alone
// does not: a computed oklch() serialises as oklch(), and polished takes only
// hex/rgb/hsl. The pixel is the colour in plain sRGB bytes.
let probe: CanvasRenderingContext2D | null | undefined;

function normaliseColor(value: string): string | null {
  if (probe === undefined) {
    probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
  }
  if (!probe || !value) {
    return null;
  }
  probe.fillStyle = '#000000';
  probe.fillStyle = value;
  const asBlack = probe.fillStyle;
  probe.fillStyle = '#ffffff';
  probe.fillStyle = value;
  if (probe.fillStyle !== asBlack) {
    return null;
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  if (a === 0) {
    return 'rgba(0, 0, 0, 0)';
  }
  // Canvas stores pixels premultiplied by alpha, so a translucent token has to
  // be divided back out to recover the colour it was written as.
  const scale = 255 / a!;
  const channel = (v: number) => Math.min(255, Math.round(v * scale));
  return a === 255
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${channel(r!)}, ${channel(g!)}, ${channel(b!)}, ${(a! / 255).toFixed(3)})`;
}

function resolve(group: Record<string, string>): Record<string, string> {
  const rootStyle = getComputedStyle(document.documentElement);
  const resolved: Record<string, string> = {};
  for (const [key, property] of Object.entries(group)) {
    const raw = rootStyle.getPropertyValue(property).trim();
    const colour = raw ? normaliseColor(raw) : null;
    if (colour !== null) {
      resolved[key] = colour;
    }
  }
  return resolved;
}

// Read fresh on every call: the caller re-invokes it when the colour mode
// changes, and Docusaurus has already written the new data-theme onto <html> by
// then (ColorModeAttribute.set runs before the state update that re-renders us).
export function redocTheme(prismPlain: {color?: string; backgroundColor?: string}): RedocRawOptions['theme'] {
  return {
    // The one spacing value the Antora theme set, kept: it is what stops each
    // operation being separated by a screenful of whitespace.
    spacing: {sectionVertical: 20},
    // Redoc splits each operation into a description column and a dark samples
    // column, sized as a fraction of the VIEWPORT because it expects to own the
    // page. Here it has one docs column to work in, which is never wide enough
    // for two readable columns, so the split is switched off by putting its
    // "narrow" breakpoint out of reach: samples stack under the operation they
    // belong to, at every width.
    breakpoints: {medium: '9999rem'},
    colors: {
      primary: resolve(TOKENS.primary),
      text: resolve(TOKENS.text),
      border: resolve(TOKENS.border),
    },
    schema: resolve(TOKENS.schema),
    // The request/response samples. Redoc renders them in a dark rail down the
    // side of the page, with a syntax theme (prism-dark, hardcoded in its
    // PrismDiv) that only works on a dark background. Here they are ordinary
    // code blocks in the flow, so both the panel and the block inside it take
    // the SITE's code-block surface — the same prism theme object the site's own
    // CodeBlock renders with (docusaurus.config themeConfig.prism), so there is
    // one definition of "what code looks like here" rather than two. The token
    // colours come from the same object; see prismTokenCss in Renderer.tsx.
    rightPanel: {backgroundColor: prismPlain.backgroundColor, textColor: prismPlain.color},
    codeBlock: {backgroundColor: prismPlain.backgroundColor},
    typography: {
      fontFamily: 'var(--ifm-font-family-base)',
      headings: {fontFamily: 'var(--ifm-heading-font-family)'},
      code: {fontFamily: 'var(--ifm-font-family-monospace)', ...resolve(TOKENS.code)},
      links: resolve(TOKENS.links),
    },
  } as RedocRawOptions['theme'];
}
