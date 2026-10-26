import clsx from 'clsx';
import { HTMLAttributes } from 'react';

import styles from './LegalContainer.module.css';

export interface LegalContainerProps extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export default function LegalContainer({ children, className = '', ...props }: LegalContainerProps) {
  return (
    <div className={clsx(styles.root, className)} {...props}>
      {children}
    </div>
  );
}
