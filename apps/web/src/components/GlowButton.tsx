import clsx from 'clsx';
import { ButtonHTMLAttributes } from 'react';

import Button from './Button';

import styles from './GlowButton.module.css';

interface GlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export default function GlowButton({ children, className = '', ...props }: GlowButtonProps) {
  return (
    <Button className={clsx(styles.glowButton, className)} {...props}>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      {children}
    </Button>
  );
}
