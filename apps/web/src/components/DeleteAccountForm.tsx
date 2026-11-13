import { FirebaseError } from 'firebase/app';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { OutcomeUnknownError, deleteAccount } from '@/services/account';
import { errorText } from '@/services/callable';
import { WrongPasswordError } from '@/services/signIn';

import styles from './DeleteAccountForm.module.css';

/**
 * The form on the delete account page (pages/DeleteAccount.tsx), and what it says once the
 * account is gone. Apart from the page because it imports Firebase and holds state, and
 * the page is rendered to static HTML by the build, which can have neither.
 *
 * It asks for the password even from a signed-in browser. The function refuses a sign-in
 * older than five minutes, so that an open session on a shared computer cannot delete the
 * account, and the password is the proof.
 */

/**
 * Whether an account was deleted from this form since the page loaded. Outside the component
 * because deleting from a signed-in browser ends its session, `Layout` then swaps its
 * signed-in frame for the signed-out one, and the page is mounted anew: state held in the
 * component was lost at exactly the moment it had something to say, and the person was
 * shown the empty form again with no word that anything had happened.
 *
 * It is for that one remount and no longer: the page that mounts next reads it and puts
 * it back, so a later visit in the same tab (the next person at a shared computer, or the
 * same one signed in to another account) gets the form and not someone else's result.
 */
let deletedHere = false;

/** Firebase has throttled sign-ins for this account: not a connection problem, and said as what it is. */
const TOO_MANY_TRIES = 'Too many tries. Nothing was deleted. Wait a few minutes and try again.';

/** For a failure before the function was called. The same words as the Android app. */
const NOT_ASKED =
  'Your account was not deleted: PushThat could not reach the server. Check your connection and try again.';

/** For a call that ended with no answer (`OutcomeUnknownError`). The same words on every client. */
const UNCONFIRMED =
  'We could not confirm that your account was deleted. It may still be finishing. Try again in a few minutes. If signing in with the right password no longer works, the account is gone.';

export function DeleteAccountForm() {
  const { user } = useAuth();
  const sessionEmail = user?.email ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(deletedHere);
  // On mount only, so the page that started the deletion does not clear it before the one
  // mounted in its place has read it.
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The page that was mounted anew starts at its top, and this is at its foot: without
    // this the person who had just pressed the button saw the page's first paragraph.
    if (deletedHere) doneRef.current?.scrollIntoView({ block: 'center' });
    deletedHere = false;
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !understood) return;
    setBusy(true);
    setError('');
    try {
      await deleteAccount(sessionEmail || email.trim(), password, () => {
        // Only a signed-in browser is remounted; signed out, this page stays and shows
        // the result itself, and a flag left set would greet the next visit with it.
        deletedHere = !!sessionEmail;
      });
      setPassword('');
      setDone(true);
    } catch (err) {
      setError(
        // "Could not confirm" is for a call that was made and not answered. A failure
        // before that (no network for the sign-in, too many attempts) asked nothing of
        // the server, and saying the account "may still be finishing" would be untrue the
        // other way. The function's own refusals come with their own sentence. A wrong
        // password does not say "nothing was deleted": on a second try it may be the
        // first try having worked.
        err instanceof WrongPasswordError
          ? // Signed in there is no email field, so only the password can be what was wrong.
            sessionEmail
            ? 'That is not your password.'
            : 'The email or password is not right.'
          : err instanceof OutcomeUnknownError
            ? UNCONFIRMED
            : err instanceof FirebaseError && err.code === 'auth/too-many-requests'
              ? TOO_MANY_TRIES
              : errorText(err, NOT_ASKED)
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {done ? (
        <div className={styles.done} role="status" ref={doneRef}>
          <p>
            <strong>Your account is deleted.</strong> Everything listed above under “What is deleted” is gone, and this
            browser is signed out. Your other devices sign out within the hour. You can uninstall the app.
          </p>
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit}>
          {sessionEmail ? (
            <p>
              Signed in as <strong>{sessionEmail}</strong>. This deletes that account.
            </p>
          ) : (
            <label className={styles.label}>
              Email address
              <input
                type="email"
                required
                autoComplete="username"
                className={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          <label className={styles.label}>
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className={styles.confirm}>
            <input type="checkbox" required checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>
              I understand that this is permanent: my account and everything in it is deleted, and my encrypted pushes
              cannot be recovered afterwards.
            </span>
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={styles.deleteButton} disabled={busy || !understood}>
            {busy ? 'Deleting your account…' : 'Delete my account'}
          </button>
        </form>
      )}
    </>
  );
}
