import React, {type ReactNode} from 'react';
import ContentVisibility from '@theme-original/ContentVisibility';
import type ContentVisibilityType from '@theme/ContentVisibility';
import type {WrapperProps} from '@docusaurus/types';
import {UnlistedMetadata} from '@docusaurus/theme-common';

type Props = WrapperProps<typeof ContentVisibilityType>;

// Shows the unlisted banner in development environments only
export default function ContentVisibilityWrapper(props: Props): ReactNode {
  if (process.env.NODE_ENV === 'production') {
    return props.metadata.unlisted ? <UnlistedMetadata /> : null;
  }
  return <ContentVisibility {...props} />;
}
