import { useEffect, useRef, useState } from 'react';

import Button from '@/components/Button';
import GlowButton from '@/components/GlowButton';
import { RecoveryKey } from '@/components/RecoveryKey';
import { useAuth } from '@/contexts/AuthContext';
import { useKeys } from '@/contexts/KeysContext';

import styles from './KeyStep.module.css';

/**
 * Stands in front of the signed-in pages until this device holds the account key
 * (docs/e2ee.md, Where keys live on each device): the recovery key just made, the
 * password for a session with no key, or the recovery key for a password that opens
 * nothing. The work is in KeysContext and services/signIn.ts.
 */
export function KeyGate({ children }: { children: React.ReactNode }) {
  const { step } = useKeys();
  const box = useRef<HTMLDivElement>(null);

  // As on the reset page: each step's heading takes focus, so a screen reader hears the
  // step change, above all on the recovery key. The forms focus their first field.
  useEffect(() => {
    if (step.name === 'recoveryKey' || step.name === 'withoutRecovery' || step.name === 'working') {
      box.current?.querySelector<HTMLElement>('h2')?.focus();
    }
  }, [step.name]);

  if (step.name === 'ready') return children;
  if (step.name === 'checking' || step.name === 'signedOut') return null;

  return (
    <div className={styles.container}>
      <div className={styles.box} ref={box}>
        {step.name === 'working' && (
          <h2 tabIndex={-1} className={styles.title}>
            Setting up encryption…
          </h2>
        )}
        {step.name === 'unlock' && <UnlockForm error={step.error} />}
        {step.name === 'recovery' && <RecoveryForm error={step.error} />}
        {step.name === 'withoutRecovery' && <WithoutRecovery error={step.error} />}
        {step.name === 'recoveryKey' && <NewRecoveryKey recoveryKey={step.recoveryKey} />}
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error?: string }) {
  return error ? (
    <div className={styles.error} role="alert">
      {error}
    </div>
  ) : null;
}

function UnlockForm({ error }: { error?: string }) {
  const { user, signOut } = useAuth();
  const { unlock } = useKeys();
  const [password, setPassword] = useState('');

  return (
    <>
      <h2 tabIndex={-1} className={styles.title}>
        Set up encryption
      </h2>
      <p className={styles.message}>
        PushThat now encrypts your pushes on your devices. Enter your password once to set it up here.
      </p>
      <p className={styles.message}>
        <strong>{user?.email}</strong>
      </p>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          unlock(password).catch(() => {
            // The step carries the error.
          });
        }}
      >
        <ErrorLine error={error} />
        <input
          autoFocus
          type="password"
          autoComplete="current-password"
          required
          className={styles.input}
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <GlowButton type="submit" className={styles.button}>
          Continue
        </GlowButton>
      </form>
      <div className={styles.footer}>
        <button type="button" className={styles.footerLink} onClick={signOut}>
          Sign out
        </button>
      </div>
    </>
  );
}

function RecoveryForm({ error }: { error?: string }) {
  const { recover, withoutRecovery } = useKeys();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <h2 tabIndex={-1} className={styles.title}>
        Enter your recovery key
      </h2>
      <p className={styles.message}>
        Your password was changed in a way that could not update your encryption keys. Enter your recovery key to keep
        your pushes.
      </p>
      <form
        className={styles.form}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await recover(recoveryKey);
          setBusy(false);
        }}
      >
        <ErrorLine error={error} />
        <input
          autoFocus
          required
          autoComplete="off"
          spellCheck={false}
          className={styles.input}
          aria-label="Recovery key"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
        />
        <GlowButton type="submit" className={styles.button} disabled={busy}>
          Continue
        </GlowButton>
      </form>
      <div className={styles.footer}>
        <button type="button" className={styles.footerLink} onClick={withoutRecovery} disabled={busy}>
          I don't have it
        </button>
      </div>
    </>
  );
}

function WithoutRecovery({ error }: { error?: string }) {
  const { startOver, backToRecovery } = useKeys();
  const [busy, setBusy] = useState(false);

  return (
    <>
      <h2 tabIndex={-1} className={styles.title}>
        Start over without your recovery key?
      </h2>
      <p className={styles.message}>
        Your account gets new keys and a new recovery key. Pushes encrypted before now will not be readable on any
        device.
      </p>
      <ErrorLine error={error} />
      <Button
        type="button"
        className={styles.button}
        isSubmitting={busy}
        onClick={async () => {
          setBusy(true);
          await startOver();
          setBusy(false);
        }}
      >
        Start over
      </Button>
      <div className={styles.footer}>
        <button type="button" className={styles.footerLink} onClick={backToRecovery} disabled={busy}>
          I found my recovery key
        </button>
      </div>
    </>
  );
}

function NewRecoveryKey({ recoveryKey }: { recoveryKey: string }) {
  const { savedRecoveryKey } = useKeys();

  return (
    <>
      <h2 tabIndex={-1} className={styles.title}>
        Your recovery key
      </h2>
      {/* docs/e2ee.md, Saying so: the sign-up's words, word for word. */}
      <p className={styles.message}>
        Your password is the key to your pushes, and we cannot reset it for you. Save your recovery key.
      </p>
      <p className={styles.message}>
        It is shown only once. If you forget your password, it is the only way to keep your pushes.
      </p>
      <RecoveryKey recoveryKey={recoveryKey} onDone={savedRecoveryKey} />
    </>
  );
}
