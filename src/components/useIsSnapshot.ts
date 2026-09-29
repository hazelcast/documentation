import {useDocsVersion} from '@docusaurus/plugin-content-docs/client';

// True for the unreleased (snapshot) docs version, via Docusaurus's 'unreleased' banner.
// Shared by <IfSnapshot>/<IfNotSnapshot> so the two halves can never disagree.
export default function useIsSnapshot(): boolean {
  const {banner} = useDocsVersion();
  return banner === 'unreleased';
}
