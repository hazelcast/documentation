import MDXComponents from '@theme-original/MDXComponents';
import LinkVariable from '@site/src/components/LinkVariable';
import Badge from '@site/src/components/Badge';
import CodeCallouts from '@site/src/components/CodeCallouts';

// Components registered here are available in every MDX page without an import.
export default {
  ...MDXComponents,
  LinkVariable,
  Badge,
  CodeCallouts,
};
