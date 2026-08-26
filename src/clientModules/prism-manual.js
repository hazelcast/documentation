// Disables PrismJS's automatic document-wide highlight pass.
//
// The API reference pages load Redoc, whose bundle does `require("prismjs")`.
// The full PrismJS browser build calls Prism.highlightAll() on DOMContentLoaded
// unless Prism.manual is set, and that pass rewrites EVERY element its selector
// matches -- including our React-rendered code blocks, which it reaches via
// `[class*="language-"] code` (Docusaurus puts the language class on the code
// block's container). Prism rebuilds each match from element.textContent, and
// because a Docusaurus code block renders one <div> per line ending in <br>,
// textContent has no newlines: the block collapses to a single long line.
//
// It only bit on a full page load, since SPA navigation never fires
// DOMContentLoaded -- hence "hard reload breaks it, navigating away and back
// fixes it". Redoc calls its own highlight helpers on strings explicitly, so
// nothing needs the document-wide pass.
//
// PrismJS reads `_self.Prism && _self.Prism.manual` when it initialises, so
// seeding the global with the flag is enough. This has to run AFTER
// theme-classic's own `prism-include-languages` client module, which borrows
// and then deletes globalThis.Prism and would drop the flag -- site
// clientModules are applied after the themes', so registration order in
// docusaurus.config.ts carries that.
if (typeof window !== 'undefined') {
  window.Prism = window.Prism ?? {};
  window.Prism.manual = true;
}
