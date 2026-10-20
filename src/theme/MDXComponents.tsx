import MDXComponents from '@theme-original/MDXComponents';
import Variable from '@site/src/components/Variable';
import Badge from '@site/src/components/Badge';
import CodeCallouts from '@site/src/components/CodeCallouts';
import IfSnapshot from '@site/src/components/IfSnapshot';
import IfNotSnapshot from '@site/src/components/IfNotSnapshot';
import Icon from '@site/src/components/Icon';
import Anchor from '@site/src/components/Anchor';
import ApiReference from '@site/src/components/ApiReference';
import TableCodeBreaks from '@site/src/components/TableCodeBreaks';

// Components registered here are available in every MDX page without an import.
export default {
  ...MDXComponents,
  Variable,
  Badge,
  CodeCallouts,
  IfSnapshot,
  IfNotSnapshot,
  Icon,
  Anchor,
  ApiReference,
  TableCodeBreaks,
};
