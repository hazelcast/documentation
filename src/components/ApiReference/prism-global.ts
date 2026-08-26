// Prepares PrismJS for redoc, whose bundle expects to own it.
//
// Imported for its SIDE EFFECT, on the line above Renderer's `redoc` import so
// that it runs before redoc's module factory. Two separate things have to be
// true by then, and neither is true on its own.
//
// 1. A REAL Prism has to be on the global. redoc.browser.lib.js does not bundle
//    PrismJS: it externalises it, and at module scope requires `prismjs` plus 24
//    `prismjs/components/prism-*.js` files. Those component files are not
//    modules -- each one opens by assigning to a FREE variable:
//
//      Prism.languages.sql = { ... }        // prismjs/components/prism-sql.js:1
//
//    PrismJS core puts itself there (`_self.Prism = _`), but only when its own
//    module first executes, and theme-classic's prism-include-languages borrows
//    that global and `delete`s it again. Requiring core and setting the global
//    HERE is immune to whatever happened to it earlier in the page's life.
//
// 2. The languages `themeConfig.prism.additionalLanguages` claimed have to be
//    handed over. A `prismjs/components/*` file mutates whatever Prism is
//    global and exports nothing, so it is single-use: the bundler caches it, and
//    the SECOND consumer to require it gets a no-op. There are two consumers
//    with two different Prism instances -- theme-classic, loading
//    additionalLanguages into prism-react-renderer's Prism, and redoc, loading
//    its 24 into the real one -- and theme-classic always wins, because it runs
//    as a CLIENT MODULE, at bootstrap, before any route renders. So the four
//    files `additionalLanguages: ['bash','java','properties','csharp']` names
//    are spent before redoc asks, and redoc's `prism-scala.js` --
//    `Prism.languages.extend('java', …)` -- throws on the missing grammar.
//
//    Grammars are plain data, so the ones the theme's instance was given are
//    copied across rather than fought over. Adding a language to
//    additionalLanguages needs nothing here.
//
// What (2) prevents is not a missing highlight: it is redoc's factory THROWING.
// The bundler caches the empty `module.exports`, every later require of redoc
// silently returns {}, and the page then fails somewhere else entirely -- as
// `AppStore is not a constructor`, or as an import positioned AFTER redoc's in
// Renderer reading as undefined.
//
// `manual` turns off PrismJS's document-wide highlight pass, which on
// DOMContentLoaded rebuilds every element matching `[class*="language-"] code`
// from its textContent. A Docusaurus code block renders one <div> per line, so
// its textContent has no newlines and the block collapses to a single line -- on
// a hard load only, since SPA navigation never fires DOMContentLoaded. The flag
// is read off the Prism object by the auto-highlight callback when it fires,
// not captured when the listener is registered, so setting it after the require
// that registered it still suppresses the pass. redoc calls Prism's highlight
// helpers on strings explicitly and never wanted the document-wide one.
//
// Only Renderer imports this, and Renderer is reached only on an API page, so
// `prismjs` stays out of every other page in the site. Nothing else here wants
// it: ordinary code blocks are highlighted by prism-react-renderer, which
// carries its own Prism and never reads this global.
import {Prism as themePrism} from 'prism-react-renderer';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const Prism = require('prismjs');

// `languages` also holds `extend`, `insertBefore` and the plaintext aliases, all
// of which the real Prism has already: `in` skips them, so only grammars this
// instance is actually missing are taken.
for (const [name, grammar] of Object.entries(themePrism.languages)) {
  if (!(name in Prism.languages) && grammar && typeof grammar === 'object') {
    Prism.languages[name] = grammar;
  }
}

Prism.manual = true;
(window as unknown as {Prism: unknown}).Prism = Prism;

export {};
