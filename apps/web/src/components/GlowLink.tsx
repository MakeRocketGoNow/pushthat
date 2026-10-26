import clsx from 'clsx';
import { ComponentProps } from 'react';
import { Link } from 'react-router';

import buttonStyles from './Button.module.css';
import glowStyles from './GlowButton.module.css';

type GlowLinkProps = ComponentProps<typeof Link> & {
  children: React.ReactNode;
  variant?: 'default' | 'solid';
};

export function GlowLink({ children, className = '', variant = 'default', ...props }: GlowLinkProps) {
  return (
    <Link
      className={clsx(
        buttonStyles.button,
        glowStyles.glowButton,
        variant === 'solid' && glowStyles.solid,
        className
      )}
      {...props}
    >
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      {children}
    </Link>
  );
}


