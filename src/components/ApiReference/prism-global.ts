// Prepares PrismJS for redoc, whose bundle expects to own it. Imported for its side effect, above Renderer's `redoc` import so it runs before redoc's module factory.
// 1. redoc externalises prismjs and requires 24 `prismjs/components/prism-*.js` files, which assign to a free `Prism` global. Set a real Prism on the global here;
//    theme-classic's prism-include-languages borrows that global and deletes it.
// 2. A prismjs component file is single-use (the bundler caches it). theme-classic loads `additionalLanguages` first, at bootstrap, so redoc's `prism-scala.js`
//    (`Prism.languages.extend('java', ...)`) would throw on the missing grammar and the cached empty module then fails elsewhere (`AppStore is not a constructor`).
//    Grammars are plain data, so copy the theme's instance's ones across.
// `manual` disables PrismJS's DOMContentLoaded highlight pass, which collapses Docusaurus code blocks to one line on hard loads (their textContent has no newlines).
// The flag is read when the callback fires, so setting it after the require still works.
import {Prism as themePrism} from 'prism-react-renderer';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const Prism = require('prismjs');

// Copy only grammars the real Prism lacks; `in` skips `extend`, `insertBefore` and aliases it already has.
for (const [name, grammar] of Object.entries(themePrism.languages)) {
  if (!(name in Prism.languages) && grammar && typeof grammar === 'object') {
    Prism.languages[name] = grammar;
  }
}

Prism.manual = true;
(window as unknown as {Prism: unknown}).Prism = Prism;

export {};
