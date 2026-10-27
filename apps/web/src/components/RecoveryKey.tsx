import { useState } from 'react';

import Button from '@/components/Button';
import GlowButton from '@/components/GlowButton';

import styles from './RecoveryKey.module.css';

/**
 * A recovery key on screen for the one time it is shown (docs/e2ee.md, The recovery key),
 * with a copy button and an "I saved it" box that has to be ticked before `onDone`. The
 * sign-up, a legacy account's first sign-in and the password reset page all show it
 * here; each puts its own heading and words above it.
 */
export function RecoveryKey({
  recoveryKey,
  onSavedChange,
  onDone,
}: {
  recoveryKey: string;
  /** Told when "I saved it" is ticked or unticked; the reset page asks before a tab closes until then. */
  onSavedChange?: (saved: boolean) => void;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied('yes');
    } catch {
      // No clipboard (an insecure context, or permission refused): say so, since the button
      // would otherwise look as if it had worked, and the key is on screen to copy by hand.
      setCopied('failed');
    }
  };

  return (
    <>
      <code className={styles.recoveryKey}>{recoveryKey}</code>
      <Button type="button" outline className={styles.button} onClick={copy}>
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed, select the key above' : 'Copy'}
      </Button>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => {
            setSaved(e.target.checked);
            onSavedChange?.(e.target.checked);
          }}
        />
        I saved it
      </label>
      <GlowButton type="button" className={styles.button} disabled={!saved} onClick={onDone}>
        Continue
      </GlowButton>
    </>
  );
}
