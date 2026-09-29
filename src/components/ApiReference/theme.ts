import type {RedocRawOptions} from 'redoc';

// Redoc's theme is a JS object, and Redoc runs polished's darken/transparentize over some colours, which cannot parse `var(--x)`.
// So tokens are resolved from the live custom properties at render time to plain colour strings; HIVE/Infima stay the source of truth and dark mode follows for free.
// Fonts pass through as `var(…)` and need no resolution.

// Custom property backing each Redoc colour. Unresolvable ones are left off so Redoc's default applies.
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

// Canvas as colour parser: the double fillStyle assignment detects unparseable values (a bad value leaves fillStyle unchanged);
// painting and reading back a pixel converts oklch()/color-mix() to sRGB, which polished needs.
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
  // Canvas pixels are premultiplied by alpha; divide back out.
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

// Read fresh each call: Docusaurus writes the new data-theme to <html> before the re-render that calls this.
export function redocTheme(prismPlain: {color?: string; backgroundColor?: string}): RedocRawOptions['theme'] {
  return {
    // sectionVertical stops operations being separated by a screenful of whitespace; sectionHorizontal is 0 because the docs column is already indented.
    spacing: {sectionVertical: 20, sectionHorizontal: 0},
    // Redoc's operation/samples split is viewport-based; the docs column is too narrow, so push its breakpoint out of reach to stack samples always.
    breakpoints: {medium: '9999rem'},
    colors: {
      primary: resolve(TOKENS.primary),
      text: resolve(TOKENS.text),
      border: resolve(TOKENS.border),
    },
    schema: resolve(TOKENS.schema),
    // Samples use the site's code-block surface (the themeConfig.prism theme) rather than Redoc's dark-only prism-dark rail.
    rightPanel: {backgroundColor: prismPlain.backgroundColor, textColor: prismPlain.color},
    codeBlock: {backgroundColor: prismPlain.backgroundColor},
    typography: {
      fontFamily: 'var(--ifm-font-family-base)',
      headings: {fontFamily: 'var(--ifm-heading-font-family)'},
      code: {
        fontFamily: 'var(--ifm-font-family-monospace)',
        // Redoc's 13px base compounds through nested ems to ~12.3px; an absolute size keeps samples legible.
        fontSize: '0.9rem',
        ...resolve(TOKENS.code),
      },
      links: resolve(TOKENS.links),
    },
  } as RedocRawOptions['theme'];
}
