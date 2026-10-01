import React, {type ReactNode} from 'react';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import {Button} from '@hazelcast/ui/lib/components/Button';
import {GitHub} from 'react-feather';

// "Edit this page" as a rail button under FeedbackButton, in place of the stock footer link (DocItem/Layout no longer renders
// the footer). The URL comes from the docs plugins' `editUrl` (src/docsPlugins.ts).
export default function EditPageButton(): ReactNode {
  const {editUrl} = useDoc().metadata;
  if (!editUrl) return null;
  return (
    <Button
      component="a"
      href={editUrl}
      target="_blank"
      rel={['noopener', 'noreferrer']}
      variant="outlined"
      color="secondary"
      fullWidth
      iconLeft={GitHub}
      iconLeftAriaLabel="GitHub">
      Edit this page
    </Button>
  );
}
