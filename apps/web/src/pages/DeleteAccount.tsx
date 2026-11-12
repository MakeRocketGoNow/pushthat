import { ComponentType, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import LegalContainer from '@/components/LegalContainer';
import { LIMITS, REFUND_DAYS, SUPPORT_EMAIL } from '@/config/plan';

import styles from './DeleteAccount.module.css';

/**
 * The form, fetched once the page is on screen. It signs in and calls the function, so it
 * imports Firebase, and a static page may not (src/staticPages.tsx): the build renders this
 * page in Node, where Firebase Auth keeps the process from exiting.
 *
 * Fetched in an effect, and not with `lazy`: rendering a `lazy` component starts its import
 * wherever the render happens, the build included, which loaded Firebase there and hung it.
 * An effect never runs in the build's render, so the static copy holds the line below and
 * the form arrives in the browser. That makes this the one piece of state on a static page;
 * its first render is still the same for everyone, which is what the rule is for.
 */
function FormWhenLoaded() {
  const [Form, setForm] = useState<ComponentType | null>(null);
  useEffect(() => {
    let wanted = true;
    import('@/components/DeleteAccountForm').then(
      (module) => wanted && setForm(() => module.DeleteAccountForm),
      // The chunk did not load (offline since the page did, or a deploy replaced it):
      // the line below stays, and a reload fetches the page and the form afresh.
      (error) => console.error('The delete account form did not load:', error)
    );
    return () => {
      wanted = false;
    };
  }, []);
  // Read with JavaScript off too, where it is all there will ever be under the notice
  // above it: so it must not only say to reload, which cannot help there.
  return Form ? (
    <Form />
  ) : (
    <p>
      Loading the form… If it does not appear, reload the page, or write to {SUPPORT_EMAIL} from the email address on
      the account.
    </p>
  );
}

/**
 * Delete account, `/delete-account`: what deleting removes, what is kept and for how long,
 * and the form that does it. This is the address given to Google Play as the app's account
 * deletion page, so it is public and it names the app and the developer: the person
 * reading it may have uninstalled the app, and Play's reviewer has no account at all.
 *
 * It is one of the static pages (src/staticPages.tsx), so everything except the form reads
 * without JavaScript. Keep the facts in the text itself for that reason, not behind state
 * or an effect. What is kept and for how long is recorded, with the reasons, in
 * docs/account-deletion.md at the repository root; the two change together.
 */
export function DeleteAccount() {
  return (
    <LegalContainer className={styles.root}>
      <Helmet>
        <title>Delete your PushThat account</title>
      </Helmet>

      <h1>Delete your PushThat account</h1>

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
        <li>
          Enter your password to confirm, and press <strong>Delete account</strong>.
        </li>
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
          Every push: the links, the titles and icons of their pages, and the file records, which are stored encrypted,
          and the search tokens made from them.
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

      <noscript>
        <p className={styles.noscript}>
          The form needs JavaScript. Without it, write to {SUPPORT_EMAIL} from the email address on the account and we
          will delete it for you.
        </p>
      </noscript>
      <FormWhenLoaded />
    </LegalContainer>
  );
}
