import { ReactNode } from 'react';

interface UnauthedLayoutProps {
  children: ReactNode;
}

export default function UnauthedLayout({ children }: UnauthedLayoutProps) {
  return children;
}
