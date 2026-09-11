import type {ReactNode} from 'react';
import {useLocation} from '@docusaurus/router';
import {Button} from '@hazelcast/ui/lib/components/Button';

// Navbar CTA, rendered as a real HIVE Button in anchor mode and
// registered as the `custom-cta` navbar item type (see
// src/theme/NavbarItem/ComponentTypes.tsx). Mirrors the production Antora
// header, whose CTA is context-dependent: Cloud pages get "Try Free"
// (-> <cloud-console>sign-up); every other page gets "Try Hazelcast".
const CLOUD_CTA = {
  label: 'Try Free',
  href: 'https://cloud.hazelcast.com/sign-up',
};
const DEFAULT_CTA = {
  label: 'Try Hazelcast',
  href: 'https://hazelcast.com/get-started/?utm_source=docs-website&utm_term=get-started',
};

// `mobile` is passed by the burger sidebar, whose items live in a
// <ul class="menu__list">: a bare <a> there is invalid markup and lays out as an
// inline pill instead of a menu row, so that form brings its own <li> and fills
// the width. The navbar copy is hidden below 996px in custom.css.
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
