import { FirebaseError } from 'firebase/app';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import Button from '@/components/Button';
import GlowButton from '@/components/GlowButton';
import {
  PasswordChangedError,
  ResetSession,
  WrongRecoveryKeyError,
  afterPasswordChanged,
  emailForResetCode,
  hasRecoveryWrap,
  rewrapWithRecoveryKey,
  setNewPassword,
  startNewKeys,
} from '@/services/passwordReset';

import styles from './ResetPassword.module.css';

// What docs/e2ee.md asks of a new password at sign-up, since the password is the key.
const MIN_PASSWORD_LENGTH = 10;

type Step =
  | { name: 'checking' }
  | { name: 'badLink'; reason: 'mode' | 'code' }
  | { name: 'password'; email: string }
  | { name: 'recovery'; session: ResetSession }
  | { name: 'withoutRecovery'; session: ResetSession }
  | { name: 'newRecoveryKey'; recoveryKey: string; deleted: number; deleteFailed: boolean }
  | { name: 'done' };

/**
 * `/reset`, where the password reset email's action URL points (Authentication,
 * Templates, in the Firebase console; see docs/deploying.md). Firebase adds `mode` and
 * `oobCode` to the URL. The work is in services/passwordReset.ts; this page asks for the
 * new password, then for the recovery key, and says what is lost without it before
 * anything is.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');
  const [step, setStep] = useState<Step>({ name: 'checking' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The action URL is the same for every email template, so a link of another kind
    // could land here; this page only resets passwords.
    if (mode !== null && mode !== 'resetPassword') {
      setStep({ name: 'badLink', reason: 'mode' });
      return;
    }
    if (!oobCode) {
      setStep({ name: 'badLink', reason: 'code' });
      return;
    }
    emailForResetCode(oobCode)
      .then((email) => setStep({ name: 'password', email }))
      .catch(() => setStep({ name: 'badLink', reason: 'code' }));
  }, [mode, oobCode]);

  // Runs one step at a time, and shows its error where the step's form is.
  const run = async (action: () => Promise<void>, describe: (error: unknown) => string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      console.error('Password reset step failed:', error);
      setError(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const startOver = (session: ResetSession, deleteLocked: boolean) =>
    run(
      async () => {
        setStep({ name: 'newRecoveryKey', ...(await startNewKeys(session, { deleteLocked })) });
      },
      () => 'Your password is changed, but your new keys could not be saved. Try again.'
    );

  return (
    <div className={styles.container}>
      <div className={styles.box}>
        <div className={styles.logo}>
          <img src="/pushthat.svg" alt="PushThat Icon" className={styles.icon} />
        </div>
        {step.name === 'checking' && <p className={styles.message}>Checking your link…</p>}

        {step.name === 'badLink' && (
          <>
            <h2 className={styles.title}>
              {step.reason === 'mode' ? 'This is not a password reset link' : 'This link has expired'}
            </h2>
            <p className={styles.message}>
              {step.reason === 'mode'
                ? 'This page only resets passwords.'
                : 'A reset link works once, for a limited time. Ask for a new one from the sign-in page.'}
            </p>
            <div className={styles.footer}>
              <Link className={styles.footerLink} to="/login">
                Back to sign in
              </Link>
            </div>
          </>
        )}

        {step.name === 'password' && oobCode && (
          <PasswordForm
            email={step.email}
            busy={busy}
            error={error}
            onSubmit={(password) =>
              run(
                async () => {
                  const session = await setNewPassword(oobCode, step.email, password);
                  if (!session.e2ee) {
                    // Nothing is encrypted yet, so there is nothing to recover: the
                    // account gets its first keys, and its recovery key to save.
                    const keys = await afterPasswordChanged(() => startNewKeys(session, { deleteLocked: false }));
                    setStep({ name: 'newRecoveryKey', ...keys });
                  } else {
                    setStep(
                      hasRecoveryWrap(session) ? { name: 'recovery', session } : { name: 'withoutRecovery', session }
                    );
                  }
                },
                (error) =>
                  error instanceof PasswordChangedError
                    ? 'Your password is changed, but your keys could not be updated. Sign in with your new password to finish.'
                    : error instanceof FirebaseError &&
                        (error.code === 'auth/expired-action-code' || error.code === 'auth/invalid-action-code')
                      ? 'This link has expired. Ask for a new one from the sign-in page.'
                      : 'Your password could not be changed. Try again.'
              )
            }
          />
        )}

        {step.name === 'recovery' && (
          <RecoveryForm
            busy={busy}
            error={error}
            onSubmit={(recoveryKey) =>
              run(
                async () => {
                  await rewrapWithRecoveryKey(step.session, recoveryKey);
                  setStep({ name: 'done' });
                },
                (error) =>
                  error instanceof WrongRecoveryKeyError
                    ? 'That is not the recovery key for this account. Check it and try again.'
                    : 'Your keys could not be saved. Try again.'
              )
            }
            onWithout={() => {
              setError('');
              setStep({ name: 'withoutRecovery', session: step.session });
            }}
          />
        )}

        {step.name === 'withoutRecovery' && (
          <>
            <h2 className={styles.title}>Start over without your recovery key?</h2>
            <p className={styles.message}>
              Your pushes are encrypted with a key that only your old password or your recovery key can open. Without
              the recovery key, <strong>the pushes you made before this reset cannot be read</strong> by anyone, us
              included.
            </p>
            <p className={styles.message}>
              You can delete them now, or keep them in your list as locked rows that you can delete later but never
              open. Files expire on their own within 30 days either way.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <Button
              type="button"
              className={styles.button}
              isSubmitting={busy}
              onClick={() => startOver(step.session, true)}
            >
              Start over and delete them
            </Button>
            <Button
              type="button"
              outline
              className={styles.button}
              isSubmitting={busy}
              onClick={() => startOver(step.session, false)}
            >
              Start over and keep them locked
            </Button>
            {hasRecoveryWrap(step.session) && (
              <div className={styles.footer}>
                <button
                  type="button"
                  className={styles.footerLink}
                  onClick={() => {
                    setError('');
                    setStep({ name: 'recovery', session: step.session });
                  }}
                  disabled={busy}
                >
                  I found my recovery key
                </button>
              </div>
            )}
          </>
        )}

        {step.name === 'newRecoveryKey' && (
          <NewRecoveryKey
            recoveryKey={step.recoveryKey}
            deleted={step.deleted}
            deleteFailed={step.deleteFailed}
            onDone={() => setStep({ name: 'done' })}
          />
        )}

        {step.name === 'done' && (
          <>
            <h2 className={styles.title}>Your password is changed</h2>
            <p className={styles.message}>Sign in with your new password, here and on your other devices.</p>
            <div className={styles.footer}>
              <Link className={styles.footerLink} to="/login">
                Sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PasswordForm({
  email,
  busy,
  error,
  onSubmit,
}: {
  email: string;
  busy: boolean;
  error: string;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problem, setProblem] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setProblem(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    } else if (password !== confirmation) {
      setProblem('The passwords do not match.');
    } else {
      setProblem('');
      onSubmit(password);
    }
  };

  return (
    <>
      <h2 className={styles.title}>Choose a new password</h2>
      <p className={styles.message}>
        For <strong>{email}</strong>
      </p>
      <form className={styles.form} onSubmit={submit}>
        {(problem || error) && <div className={styles.error}>{problem || error}</div>}
        <input
          autoFocus
          type="password"
          autoComplete="new-password"
          required
          className={styles.input}
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          required
          className={styles.input}
          placeholder="New password again"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
        <GlowButton type="submit" className={styles.button} disabled={busy}>
          {busy ? 'Changing your password…' : 'Change password'}
        </GlowButton>
      </form>
    </>
  );
}

function RecoveryForm({
  busy,
  error,
  onSubmit,
  onWithout,
}: {
  busy: boolean;
  error: string;
  onSubmit: (recoveryKey: string) => void;
  onWithout: () => void;
}) {
  const [recoveryKey, setRecoveryKey] = useState('');

  return (
    <>
      <h2 className={styles.title}>Enter your recovery key</h2>
      <p className={styles.message}>
        Your password is changed. Your pushes are encrypted with a key your old password opened, so enter the recovery
        key you saved when you signed up to keep them.
      </p>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(recoveryKey);
        }}
      >
        {error && <div className={styles.error}>{error}</div>}
        <input
          autoFocus
          required
          autoComplete="off"
          spellCheck={false}
          className={styles.input}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
        />
        <GlowButton type="submit" className={styles.button} disabled={busy}>
          Keep my pushes
        </GlowButton>
      </form>
      <div className={styles.footer}>
        <button type="button" className={styles.footerLink} onClick={onWithout} disabled={busy}>
          I do not have my recovery key
        </button>
      </div>
    </>
  );
}

function NewRecoveryKey({
  recoveryKey,
  deleted,
  deleteFailed,
  onDone,
}: {
  recoveryKey: string;
  deleted: number;
  deleteFailed: boolean;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      // No clipboard (an insecure context, or permission refused): the key is on screen to copy by hand.
    }
  };

  return (
    <>
      <h2 className={styles.title}>Save your recovery key</h2>
      <p className={styles.message}>
        Your password is changed
        {deleted > 0 && `, and ${deleted} locked push${deleted === 1 ? ' is' : 'es are'} deleted`}. If you forget your
        password, this key is the only way to keep your pushes. We cannot show it again.
      </p>
      {deleteFailed && (
        <p className={styles.message}>
          Some of your locked pushes could not be deleted. They stay in your list, where you can delete them.
        </p>
      )}
      <code className={styles.recoveryKey}>{recoveryKey}</code>
      <Button type="button" outline className={styles.button} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved it
      </label>
      <GlowButton type="button" className={styles.button} disabled={!saved} onClick={onDone}>
        Continue
      </GlowButton>
    </>
  );
}
