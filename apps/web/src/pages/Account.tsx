import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import { PlanSection } from '@/components/PlanSection';
import { PLAN_PAGE_LINKED } from '@/config/plan';
import { useAuth } from '@/contexts/AuthContext';
import { deviceId } from '@/services/keyStore';

import styles from './Account.module.css';

/**
 * Account, `/account`: the menu's way into everything about the account. The plan, who is
 * signed in, the "Encrypted" line, and the way to delete the account.
 *
 * The plan comes first because it is what most people open this page for, and it is all
 * here rather than a line linking to a page of its own: Account was four short sections, one
 * of them a link to the page with the substance, which was a click that bought nothing.
 *
 * One page, rather than a settings layout with the plan and deletion as tabs, because
 * deletion cannot move into one: `/delete-account` is public (it is the address given to
 * Google Play, read by people with no account), so this page links out to it.
 */
export function Account() {
  const { user } = useAuth();

  return (
    <div className={styles.page}>
      <Helmet>
        <title>Account</title>
      </Helmet>
      <h1>Account</h1>

      {PLAN_PAGE_LINKED && <PlanSection />}

      <section className={styles.section}>
        <h2>Email</h2>
        <p className={styles.email}>{user?.email}</p>
      </section>

      <Encrypted />

      <section className={styles.section}>
        <h2>Delete account</h2>
        <p>
          Deletes the account and everything pushed from it, at once and for good. The next page says exactly what goes
          and asks for your password first.
        </p>
        <p>
          <Link to="/delete-account" className={styles.danger}>
            Delete account
          </Link>
        </p>
      </section>
    </div>
  );
}

/**
 * The "Encrypted" line (docs/e2ee.md, Saying so): that the pushes are encrypted, this
 * device's id, and where to read what that means. The id is what this install puts on its
 * pushes in place of the device's model name, so showing it lets someone see all the
 * server is told about the device. IndexedDB can refuse (a private window in some
 * browsers), and the line then goes without the id rather than not at all.
 */
function Encrypted() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    deviceId()
      .then((made) => current && setId(made))
      .catch((error) => console.error('Could not read the device id:', error));
    return () => {
      current = false;
    };
  }, []);

  return (
    <section className={styles.section}>
      <h2>Encrypted</h2>
      <p>
        Your pushes are encrypted on your devices with a key made from your password, and only they can read them.{' '}
        <Link to="/security">How it works</Link>.
      </p>
      {id && (
        <p className={styles.muted}>
          This device: <code className={styles.deviceId}>{id}</code>
        </p>
      )}
    </section>
  );
}
