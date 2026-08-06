import MDXComponents from '@theme-original/MDXComponents';
import Variable from '@site/src/components/Variable';
import Badge from '@site/src/components/Badge';
import CodeCallouts from '@site/src/components/CodeCallouts';

// Components registered here are available in every MDX page without an import.
export default {
  ...MDXComponents,
  Variable,
  Badge,
  CodeCallouts,
};
