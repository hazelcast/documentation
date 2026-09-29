import type {ReactNode} from 'react';
import {useLocation} from '@docusaurus/router';
import {Button} from '@hazelcast/ui/lib/components/Button';

// Navbar CTA (`custom-cta` navbar item type): "Try Free" on Cloud pages, "Try Hazelcast" elsewhere.
const CLOUD_CTA = {
  label: 'Try Free',
  href: 'https://cloud.hazelcast.com/sign-up',
};
const DEFAULT_CTA = {
  label: 'Try Hazelcast',
  href: 'https://hazelcast.com/get-started/?utm_source=docs-website&utm_term=get-started',
};

// `mobile` is passed by the burger sidebar, whose items sit in a <ul class="menu__list">, so that form brings
// its own <li>. The navbar copy is hidden below 996px in custom.css.
export default function NavbarCta({mobile}: {mobile?: boolean}): ReactNode {
  const {pathname} = useLocation();
  const onCloud = pathname === '/cloud' || pathname.startsWith('/cloud/');
  const {label, href} = onCloud ? CLOUD_CTA : DEFAULT_CTA;
  if (mobile) {
    return (
      <li className="menu__list-item">
        <Button
          component="a"
          href={href}
          target="_blank"
          rel="noopener"
          variant="contained"
          color="primary"
          className="navbar-cta"
          fullWidth
        >
          {label}
        </Button>
      </li>
    );
  }
  return (
    <Button
      component="a"
      href={href}
      target="_blank"
      rel="noopener"
      variant="contained"
      color="primary"
      className="navbar-cta"
    >
      {label}
    </Button>
  );
}
