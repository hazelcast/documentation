import React from 'react';
import {variables} from '@site/src/variables';

// A link whose destination is a single-sourced doc variable (e.g. the Cloud
// console URL). The href lives once in src/variables.ts; pages reference it by
// name. These are external destinations, so it opens in a new tab.
export default function LinkVariable({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}): React.ReactElement {
  const href = variables[name];
  return (
    <a href={href} target="_blank" rel="noopener">
      {children}
    </a>
  );
}
