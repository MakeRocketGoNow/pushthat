import { FirebaseError } from 'firebase/app';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import Button from '@/components/Button';
import GlowButton from '@/components/GlowButton';
import styles from '@/components/KeyStep.module.css';
import { RecoveryKey } from '@/components/RecoveryKey';
import {
  KeysChangedError,
  PasswordChangedError,
  ResetSession,
  WrongRecoveryKeyError,
  afterPasswordChanged,
  deleteLockedPushes,
  emailForResetCode,
  hasRecoveryWrap,
  rewrapWithRecoveryKey,
  setNewPassword,
  startNewKeys,
} from '@/services/passwordReset';
import { MIN_PASSWORD_LENGTH } from '@/services/signIn';

/*
 * A new recovery key is stored on the server before it is shown, and the reset link is
 * used up by then, so a reload on the key's screen used to land on "This link has expired"
 * with a key nobody had seen. Until the user says they saved it, the key is kept in this
 * tab's sessionStorage beside the link's code, and the page shows it again for that code
 * before it checks the link. sessionStorage rather than localStorage: it ends with the tab,
 * so a key never confirmed does not stay behind on a shared computer, and closing the tab
 * is asked about instead (`NewRecoveryKey`'s beforeunload). Storage can be missing or
 * refuse (a private window, blocked site data), and the page still works without it.
 */
const UNSAVED_RECOVERY_KEY = 'reset.unsavedRecoveryKey';

function keepUnsavedRecoveryKey(oobCode: string, recoveryKey: string) {
  try {
    sessionStorage.setItem(UNSAVED_RECOVERY_KEY, JSON.stringify({ oobCode, recoveryKey }));
  } catch {
    // Shown all the same; only a reload loses it.
  }
}

function unsavedRecoveryKeyFor(oobCode: string): string | undefined {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(UNSAVED_RECOVERY_KEY) ?? 'null');
    if (typeof kept !== 'object' || kept === null) return undefined;
    const { oobCode: keptCode, recoveryKey } = kept as { oobCode?: unknown; recoveryKey?: unknown };
    return keptCode === oobCode && typeof recoveryKey === 'string' ? recoveryKey : undefined;
  } catch {
    return undefined;
  }
}

function forgetUnsavedRecoveryKey() {
  try {
    sessionStorage.removeItem(UNSAVED_RECOVERY_KEY);
  } catch {
    // Nothing was kept.
  }
}

// Deleting the pushes the old key locked, which runs after the new recovery key is shown.
type Deletion = { state: 'none' } | { state: 'running' } | { state: 'done'; deleted: number } | { state: 'failed' };

type Step =
  | { name: 'checking' }
  | { name: 'badLink'; reason: 'mode' | 'code' }
  | { name: 'password'; email: string }
  | { name: 'recovery'; session: ResetSession }
  | { name: 'withoutRecovery'; session: ResetSession }
  | { name: 'newRecoveryKey'; recoveryKey: string; deletion: Deletion }
  | { name: 'done' }
  | { name: 'keysNotUpdated' };

/**
 * `/reset`, where the password reset email's link lands: every client asks for the email
 * with `resetActionCodeSettings` (services/passwordReset.ts), since the template's action
 * URL cannot be changed on this project. Firebase adds `mode` and `oobCode` to the URL.
 * The work is in services/passwordReset.ts; this page asks for the new password, then for
 * the recovery key, and says what is lost without it before anything is.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');
  const [step, setStep] = useState<Step>({ name: 'checking' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

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
    // A reload while the new recovery key was on screen: the link is used, the key is not saved.
    const unsaved = unsavedRecoveryKeyFor(oobCode);
    if (unsaved) {
      setStep({ name: 'newRecoveryKey', recoveryKey: unsaved, deletion: { state: 'none' } });
      return;
    }
    emailForResetCode(oobCode)
      .then((email) => setStep({ name: 'password', email }))
      .catch(() => setStep({ name: 'badLink', reason: 'code' }));
  }, [mode, oobCode]);

  // The button that led to a step goes with the step before it, which drops focus to the
  // page. Each step's heading takes it instead, so a keyboard or screen reader user hears
  // the step change, above all on the recovery key the user must read. The steps with a
  // form focus its first field instead.
  useEffect(() => {
    if (step.name === 'checking' || step.name === 'password' || step.name === 'recovery') return;
    box.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [step.name]);

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

  const showRecoveryKey = (recoveryKey: string, deletion: Deletion) => {
    if (oobCode) keepUnsavedRecoveryKey(oobCode, recoveryKey);
    setStep({ name: 'newRecoveryKey', recoveryKey, deletion });
  };

  const setDeletion = (deletion: Deletion) =>
    setStep((current) => (current.name === 'newRecoveryKey' ? { ...current, deletion } : current));

  const startOver = (session: ResetSession, deleteLocked: boolean) =>
    run(
      async () => {
        const recoveryKey = await startNewKeys(session);
        // The key is stored, so it goes on screen now, before the delete, which can take a
        // while on a large account and must not stand between the user and the only copy.
        showRecoveryKey(recoveryKey, { state: deleteLocked ? 'running' : 'none' });
        if (deleteLocked) {
          deleteLockedPushes(session).then(
            (deleted) => setDeletion({ state: 'done', deleted }),
            (error) => {
              console.error('Deleting the locked pushes failed:', error);
              setDeletion({ state: 'failed' });
            }
          );
        }
      },
      () => 'Your password is changed, but your new keys could not be saved. Try again.'
    );

  return (
    <div className={styles.container}>
      <div className={styles.box} ref={box}>
        <div className={styles.logo}>
          <img src="/pushthat.svg" alt="PushThat Icon" className={styles.icon} />
        </div>
        {step.name === 'checking' && <p className={styles.message}>Checking your link…</p>}

        {step.name === 'badLink' && (
          <>
            <h2 tabIndex={-1} className={styles.title}>
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
                  try {
                    const session = await setNewPassword(oobCode, step.email, password);
                    if (!session.e2ee) {
                      // Nothing is encrypted yet, so there is nothing to recover: the
                      // account gets its first keys, and its recovery key to save.
                      const recoveryKey = await afterPasswordChanged(() => startNewKeys(session));
                      showRecoveryKey(recoveryKey, { state: 'none' });
                    } else {
                      setStep(
                        hasRecoveryWrap(session) ? { name: 'recovery', session } : { name: 'withoutRecovery', session }
                      );
                    }
                  } catch (error) {
                    // The link is used up once Firebase has the new password, so this
                    // ends here rather than leaving a form whose retry can only fail.
                    if (error instanceof PasswordChangedError) setStep({ name: 'keysNotUpdated' });
                    else throw error;
                  }
                },
                (error) =>
                  error instanceof FirebaseError &&
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
                    : error instanceof KeysChangedError
                      ? 'Your keys were changed on another device since this page opened. Sign in with your newest password.'
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
            <h2 tabIndex={-1} className={styles.title}>
              Start over without your recovery key?
            </h2>
            <p className={styles.message}>
              Your pushes are encrypted with a key that only your old password or your recovery key can open. Without
              the recovery key, <strong>the pushes you made before this reset cannot be read</strong> by anyone, us
              included.
            </p>
            <p className={styles.message}>
              You can delete them now, or keep them in your list as locked rows that you can delete later but never
              open. Files expire on their own within 30 days either way.
            </p>
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
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
            deletion={step.deletion}
            onDone={() => {
              forgetUnsavedRecoveryKey();
              setStep({ name: 'done' });
            }}
          />
        )}

        {step.name === 'keysNotUpdated' && (
          <>
            <h2 tabIndex={-1} className={styles.title}>
              Your password is changed
            </h2>
            {/* The sign-in (services/signIn.ts, and its copy on each app) asks for the
                recovery key when a working password opens no wrap, as this page does. */}
            <p className={styles.message}>
              The keys to your pushes could not be updated. Sign in with your new password and the app will finish.
            </p>
            <div className={styles.footer}>
              <Link className={styles.footerLink} to="/login">
                Sign in
              </Link>
            </div>
          </>
        )}

        {step.name === 'done' && (
          <>
            <h2 tabIndex={-1} className={styles.title}>
              Your password is changed
            </h2>
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
      <h2 tabIndex={-1} className={styles.title}>
        Choose a new password
      </h2>
      <p className={styles.message}>
        For <strong>{email}</strong>
      </p>
      <form className={styles.form} onSubmit={submit}>
        {(problem || error) && (
          <div className={styles.error} role="alert">
            {problem || error}
          </div>
        )}
        <input
          autoFocus
          type="password"
          autoComplete="new-password"
          required
          className={styles.input}
          aria-label="New password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          required
          className={styles.input}
          aria-label="Confirm new password"
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
      <h2 tabIndex={-1} className={styles.title}>
        Enter your recovery key
      </h2>
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
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
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
  deletion,
  onDone,
}: {
  recoveryKey: string;
  deletion: Deletion;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);

  // Closing the tab ends the sessionStorage copy too, so the browser asks first until the
  // user says they saved the key.
  useEffect(() => {
    if (saved) return;
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set; what it says is not shown any more.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [saved]);

  return (
    <>
      <h2 tabIndex={-1} className={styles.title}>
        Save your recovery key
      </h2>
      <p className={styles.message}>
        Your password is changed. If you forget your password, this key is the only way to keep your pushes. We cannot
        show it again.
      </p>
      {deletion.state === 'running' && <p className={styles.message}>Deleting your locked pushes…</p>}
      {deletion.state === 'done' && deletion.deleted > 0 && (
        <p className={styles.message}>
          {deletion.deleted} locked push{deletion.deleted === 1 ? ' is' : 'es are'} deleted.
        </p>
      )}
      {deletion.state === 'failed' && (
        <p className={styles.message}>
          Some of your locked pushes could not be deleted. They stay in your list, where you can delete them.
        </p>
      )}
      <RecoveryKey recoveryKey={recoveryKey} onSavedChange={setSaved} onDone={onDone} />
    </>
  );
}
