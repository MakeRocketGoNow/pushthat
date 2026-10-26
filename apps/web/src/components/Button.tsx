import clsx from 'clsx';
import { ButtonHTMLAttributes } from 'react';

import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  isSubmitting?: boolean;
  outline?: boolean;
  solid?: boolean;
}

export default function Button({
  children,
  className = '',
  isSubmitting = false,
  outline = false,
  solid = false,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx(
        styles.button,
        className,
        isSubmitting && styles.buttonDisabled,
        outline && styles.outline,
        solid && styles.solid
      )}
      disabled={isSubmitting}
      {...props}
    >
      {children}
    </button>
  );
}
