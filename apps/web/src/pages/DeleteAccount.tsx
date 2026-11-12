import { useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import LegalContainer from '@/components/LegalContainer';
import { LIMITS, REFUND_DAYS, SUPPORT_EMAIL } from '@/config/plan';
import { useAuth } from '@/contexts/AuthContext';
import { deleteAccount } from '@/services/account';
import { errorText } from '@/services/plan';
import { WrongPasswordError } from '@/services/signIn';

import styles from './DeleteAccount.module.css';

/**
 * Delete account, `/delete-account`: what deleting removes, what is kept and for how long,
 * and the form that does it. This is the address given to Google Play as the app's account
 * deletion page, so it is public and it names the app and the developer: the person
 * reading it may have uninstalled the app, and Play's reviewer has no account at all.
 *
 * It is also served as static HTML (scripts/prerender.mjs), so everything except the form
 * reads without JavaScript. Keep the facts in the text itself for that reason, not behind
 * state or an effect. What is kept and for how long is recorded, with the reasons, in
 * docs/account-deletion.md at the repository root; the two change together.
 *
 * The form asks for the password even from a signed-in browser. The function refuses a
 * sign-in older than five minutes, so that an open session on a shared computer cannot
 * delete the account, and the password is the proof.
 */

/**
 * Whether an account was deleted from this page since it loaded. Outside the component
 * because deleting from a signed-in browser ends its session, `Layout` then swaps its
 * signed-in frame for the signed-out one, and the page is mounted anew: state held in the
 * component was lost at exactly the moment it had something to say, and the person was
 * shown the empty form again with no word that anything had happened.
 */
let deletedHere = false;

export function DeleteAccount() {
  const { user } = useAuth();
  const sessionEmail = user?.email ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(deletedHere);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !understood) return;
    setBusy(true);
    setError('');
    try {
      await deleteAccount(sessionEmail || email.trim(), password, () => {
        deletedHere = true;
      });
      setPassword('');
      setDone(true);
    } catch (err) {
      setError(
        err instanceof WrongPasswordError
          ? 'The email or password is not right. Nothing was deleted.'
          : errorText(err, 'The account could not be deleted. Nothing was removed; try again shortly.')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <LegalContainer className={styles.root}>
      <Helmet>
        <title>Delete your PushThat account</title>
      </Helmet>

      <h1>Delete your PushThat account</h1>

      {/* At the top: the page has just been mounted anew, scrolled to its start (see `deletedHere`). */}
      {done && (
        <div className={styles.done} role="status">
          <p>
            <strong>Your account is deleted.</strong> Everything listed below under “What is deleted” is gone, and this
            browser is signed out. Your other devices sign out within the hour. You can uninstall the app.
          </p>
        </div>
      )}

      <p>
        PushThat is an app by MakeRocketGoNow LLC for sending links and files between your phone and your other devices.
        This page explains how to delete your PushThat account and the data stored with it, and lets you do it right
        here. Deleting is permanent and takes effect at once: the account is removed, not switched off, and there is no
        waiting period and no way to restore it.
      </p>

      <h5>HOW TO DELETE YOUR ACCOUNT</h5>

      <p>In the app:</p>
      <ol>
        <li>
          Open PushThat and open its menu: the three dots at the top of the list on Android, the account menu on iPhone
          and Mac, and the menu at the top right on the website and in the Chrome extension.
        </li>
        <li>
          Choose <strong>Delete account</strong>.
        </li>
        <li>Enter your password to confirm, and press Delete.</li>
      </ol>

      <p>Without the app, on this page:</p>
      <ol>
        <li>
          Enter the email address and password of the account in the <a href="#delete">form below</a>.
        </li>
        <li>Tick the box to confirm that you understand it is permanent.</li>
        <li>
          Press <strong>Delete my account</strong>. It is deleted while you wait, and the page says so when it is done.
        </li>
      </ol>

      <p>
        If you have forgotten your password, reset it first from the <Link to="/login">sign-in page</Link> (Forgot your
        password?), then come back and use the new one. You do not need your recovery key to delete the account. If you
        cannot sign in at all, or this page does not work for you, write to{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the email address on the account and we will delete
        it for you.
      </p>

      <h5>WHAT IS DELETED</h5>

      <p>All of this is deleted when you press the button:</p>
      <ul>
        <li>Your account: your email address, your sign-in and your account ID.</li>
        <li>
          Every push: the links, page titles and file records, which are stored encrypted, and the search tokens made
          from them.
        </li>
        <li>Every file you pushed that is still stored, in its encrypted form.</li>
        <li>
          Your encryption keys as we hold them: the copy locked by your password and the copy locked by your recovery
          key. Without them your encrypted pushes cannot be read by anyone, so nothing can be recovered afterwards, by
          you or by us.
        </li>
        <li>Your device records: the notification tokens and device IDs of the devices you signed in on.</li>
        <li>Your monthly usage counts and the record of your plan.</li>
        <li>
          Your Pro subscription, if you have one: it is cancelled at once and you are not charged again, and your
          customer record at Stripe, our payment provider, is deleted. Deleting does not refund a payment by itself; a
          charge made in the last {REFUND_DAYS} days is refunded if you ask (see the{' '}
          <Link to="/terms#refunds">refund policy</Link>).
        </li>
        <li>
          Every session: you are signed out on this device at once, and on every other device within an hour, as each
          one next checks in.
        </li>
      </ul>

      <h5>WHAT IS KEPT, AND FOR HOW LONG</h5>

      <ul>
        <li>
          <strong>About two hours:</strong> a marker holding only the deleted account’s ID and the time. A device that
          is still signed in can go on sending for up to an hour; the marker is how anything it sends in that time is
          found and deleted too. Then the marker is deleted.
        </li>
        <li>
          <strong>30 days:</strong> our server logs, which record the account ID and the storage paths of deleted files
          against the actions our servers took. They never hold your email address or the content of a push. A file
          pushed before end-to-end encryption was stored under its own name, so its name can appear in a path.
        </li>
        <li>
          <strong>Up to 180 days:</strong> backup copies that Google, which runs our servers, keeps of its own systems.
          We cannot read an account out of them, and they expire on Google’s schedule.
        </li>
        <li>
          <strong>As long as the law requires:</strong> if you ever paid for Pro, Stripe keeps its records of those
          payments (receipts and invoices, with the email address they were sent to) for tax and accounting. Stripe was
          the seller of those payments and holds these records itself.
        </li>
        <li>
          <strong>Up to 14 months:</strong> usage statistics from the Android and iPhone apps (for example that the app
          was opened, and on what kind of device), collected by Google Analytics for Firebase. They are tied to an
          identifier for an installation of the app, not to your account or your email address, and the app resets that
          identifier when you delete your account from it.
        </li>
        <li>Email you have sent us stays in our mailbox until you ask us to delete it too.</li>
      </ul>

      <p>
        Apart from deleting your account, a pushed file is always deleted on its own {LIMITS.free.keepDays} days after
        it was pushed on the free plan and {LIMITS.pro.keepDays} days on Pro, and you can delete any push from the list
        at any time. The <Link to="/privacy">privacy policy</Link> describes everything PushThat stores.
      </p>

      <h5 id="delete">DELETE YOUR ACCOUNT NOW</h5>

      {done ? (
        <p>Done: the account is deleted. There is nothing more to do here.</p>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit}>
          <noscript>
            <p className={styles.error}>
              This form needs JavaScript. Without it, write to {SUPPORT_EMAIL} from the email address on the account and
              we will delete it for you.
            </p>
          </noscript>
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
    </LegalContainer>
  );
}
