import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';

// Is the docs version being rendered the unreleased (snapshot) one?
//
// Docusaurus tags the version newer than the configured `lastVersion` with banner
// 'unreleased'; released versions get 'none' or 'unmaintained'. That is the native
// signal, so no per-version `snapshot` flag has to be carried into variables.ts.
//
// Single-sourced deliberately: <IfSnapshot> and <IfNotSnapshot> are two halves of
// one AsciiDoc conditional (`ifdef::snapshot[]` / `ifndef::snapshot[]`), and if
// they ever disagreed about what counts as a snapshot a page could show both
// branches or neither.
export default function useIsSnapshot(): boolean {
  const {banner} = useDocsVersion();
  return banner === 'unreleased';
}
